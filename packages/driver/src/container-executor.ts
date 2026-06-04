// `createContainerExecutor` — the headless backend that runs each spawn
// through `claude -p` INSIDE a container, with the container as the real
// isolation boundary. It mounts ONLY the task's dedicated clone (rw) so the
// agent can use full git, denies the rest of the host filesystem by default,
// and authenticates on the user's SUBSCRIPTION via an OAuth token forwarded as
// an env var (or, on a file-credential host, a read-only credential mount).
// That fence is what makes `--permission-mode bypassPermissions` safe to run
// unattended — the very mode a print-mode permission gate otherwise hangs on.
//
// It is a sibling of `createClaudeCodeExecutor` over the SAME sandboxed-executor
// shell: it injects a dedicated-CLONE provisioner (see `clone.ts`) instead of a
// worktree, and a docker `runSpawn` instead of a bare `claude` spawn, then
// reuses the shell's self-diff + reuse and the shared `claude -p` JSON parse
// verbatim. ZERO kernel change; the loop stays bundle/infra-blind.
//
// Honesty rule: this backend claims ONLY the isolation it provides. If Docker
// is absent the caller falls back to the worktree backend with a loud notice —
// this module never silently runs unsandboxed.
//
// Spike-proven run posture (the defaults below): run as a NON-ROOT user (bypass
// refuses uid 0), with a writable tmpfs HOME (so the agent's CLI config never
// pollutes the clone's self-diff), the clone bind-mounted at /workspace, and
// the host MCP NOT inherited (a fresh in-container config has no servers, so
// loom's own pipeline server is unreachable — no re-entrancy — without
// stripping anything the operator deliberately bakes into the image).
//
// No npm dependency: it shells out to the `docker` binary, the same posture as
// shelling to `claude`.

import { spawnSync } from "node:child_process";

import type { ProviderShuttleIntent } from "@loomfsm/kernel";

import { buildClaudeArgs, parseClaudeResult, parseClaudeUsage } from "./claude-code-executor.js";
import { provisionClone } from "./clone.js";
import type { Executor, SpawnUsage } from "./drive.js";
import { defaultRateLimitDetector, type RateLimitDetector } from "./rate-limit.js";
import { createSandboxedExecutor, type RunSpawn, type RunSpawnResult } from "./sandboxed-executor.js";
import { spawnCapture } from "./spawn-cli.js";

const DEFAULT_PERMISSION_MODE = "bypassPermissions";
const DEFAULT_WORKSPACE = "/workspace";
const DEFAULT_HOME = "/home/app";

export interface ContainerExecutorOptions {
  project_dir: string;
  // The container image to run. REQUIRED — there is no silent default: the
  // image must carry the Claude Code CLI (and git). Absence is the caller's
  // refuse/fallback decision, not a guessed image.
  image: string;
  // The Claude Code CLI name INSIDE the container. Default "claude".
  claude_bin?: string;
  // The host `docker` CLI. Default "docker" (resolved on PATH).
  docker_bin?: string;
  // Permission mode for the in-container `claude -p`. Default
  // "bypassPermissions" — safe behind the container fence.
  permission_mode?: string;
  // Cap on agentic turns (`claude --max-turns`). Omitted → CC's own default.
  max_turns?: number;
  // Kill a spawn whose whole `docker run` exceeds this wall-time → EXECUTOR_TIMEOUT
  // (transient → re-drive). Omitted → no session cap.
  session_timeout_ms?: number;
  // Kill a spawn that emits no output for this long → EXECUTOR_IDLE_TIMEOUT
  // (transient → re-drive). Omitted → no idle cap.
  idle_timeout_ms?: number;
  // Recognise a sustained rate-limit → EXECUTOR_RATE_LIMITED (wait, never
  // escalate). Injectable; default reads the envelope's `api_error_status`.
  detectRateLimit?: RateLimitDetector;
  // `docker run --network`. Omitted → docker's default bridge (outbound egress
  // for the model API; no inbound, no host network). Isolation here is
  // filesystem + process, not egress — egress is required to reach the API.
  network?: string;
  // `docker run --user`. Default = the host process uid:gid (files land
  // host-owned for the host-side merge-back, and non-root so bypass is
  // allowed). Set "" to omit and trust the image's own non-root USER.
  user?: string;
  // The in-container HOME (a writable tmpfs is mounted here). Default
  // "/home/app".
  home?: string;
  // Opt-in MCP lockdown: append `--strict-mcp-config --mcp-config
  // {"mcpServers":{}}` so the in-container CC ignores ALL MCP config. Default
  // false — the operator's image decides which (useful) MCP servers exist, and
  // the host MCP is never inherited regardless (no config is mounted).
  strict_mcp?: boolean;
  // The subscription OAuth token (from `claude setup-token`). Forwarded as
  // CLAUDE_CODE_OAUTH_TOKEN via the child env so it never appears on argv.
  oauth_token?: string;
  // A host `.credentials.json` path, mounted read-only as the in-container
  // credential (the file-credential fallback for hosts without a token env).
  cred_file?: string;
  // Extra `-v host:container[:ro]` mounts to opt in (mirrors the deny-by-default
  // posture: nothing else is mounted).
  extra_mounts?: string[];
  // Aborts the in-flight `docker run` when the drive is cancelled.
  signal?: AbortSignal;
  onNotice?: (message: string) => void;
  onUsage?: (usage: SpawnUsage) => void;
  // True when re-running a spawn is safe (the clone is deterministic + reused).
  // Default true, as for the worktree backend.
  idempotent?: boolean;
  // Test seam: inject the per-spawn runner instead of spawning real docker, so
  // the clone-provision + self-diff shell can be exercised offline.
  runSpawn?: RunSpawn;
}

export interface DockerArgsOptions {
  image: string;
  cloneDir: string;
  workspace?: string;
  home?: string;
  user?: string;
  network?: string;
  // true → forward CLAUDE_CODE_OAUTH_TOKEN by NAME (value via child env).
  oauthTokenEnv?: boolean;
  // host `.credentials.json` → mounted ro at <home>/.claude/.credentials.json.
  credFileMount?: string;
  extraMounts?: string[];
}

// Build the full `docker` argv (everything after "docker") for one spawn:
// `run --rm --init` + the spike-proven isolation flags + the clone mount + the
// inner command. Pure → unit-tested without invoking docker.
//
// `--init` runs a real init as PID1 that forwards signals and reaps children.
// It is what makes a timeout-kill tear the container down cleanly: a session /
// idle timeout SIGTERMs the `docker run` client, which forwards SIGTERM to
// PID1 — but a bare `claude` AS PID1 has no default SIGTERM handler and would
// IGNORE it, leaving the container running after the client is force-killed and
// `--rm` never firing. With `--init`, PID1 terminates on SIGTERM and `--rm`
// cleans up. No orphaned containers from a timeout.
export function buildDockerArgs(opts: DockerArgsOptions, command: string[]): string[] {
  const workspace = opts.workspace ?? DEFAULT_WORKSPACE;
  const home = opts.home ?? DEFAULT_HOME;
  const args = ["run", "--rm", "--init"];
  if (opts.user !== undefined && opts.user !== "") args.push("--user", opts.user);
  // Writable HOME for an arbitrary (host) uid, kept OUT of the clone so the
  // agent's CLI config never shows up in the self-diff.
  args.push("--tmpfs", `${home}:rw,mode=1777`, "-e", `HOME=${home}`);
  args.push("-v", `${opts.cloneDir}:${workspace}:rw`, "-w", workspace);
  if (opts.network !== undefined && opts.network !== "") args.push("--network", opts.network);
  if (opts.oauthTokenEnv === true) args.push("-e", "CLAUDE_CODE_OAUTH_TOKEN");
  if (opts.credFileMount !== undefined && opts.credFileMount !== "") {
    args.push("-v", `${opts.credFileMount}:${home}/.claude/.credentials.json:ro`);
  }
  for (const m of opts.extraMounts ?? []) args.push("-v", m);
  args.push(opts.image, ...command);
  return args;
}

// Probe for the host Docker CLI by spawning `<bin> version`. A missing binary
// surfaces as ENOENT; a present (and reachable-daemon) one exits 0. Used by the
// CLI/serve toggle to choose container vs worktree (auto) or refuse (--docker).
export function dockerAvailable(bin = "docker"): boolean {
  const res = spawnSync(bin, ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
  return res.error === undefined && res.status === 0;
}

function defaultUser(): string | undefined {
  // POSIX only — undefined on platforms without getuid (the caller may still
  // set `user` explicitly, or trust the image's USER with user: "").
  const getuid = process.getuid?.bind(process);
  const getgid = process.getgid?.bind(process);
  if (getuid === undefined || getgid === undefined) return undefined;
  return `${getuid()}:${getgid()}`;
}

export function createContainerExecutor(opts: ContainerExecutorOptions): Executor {
  const dockerBin = opts.docker_bin ?? "docker";
  const claudeBin = opts.claude_bin ?? "claude";
  const permissionMode = opts.permission_mode ?? DEFAULT_PERMISSION_MODE;
  const user = opts.user ?? defaultUser();
  const detectRateLimit = opts.detectRateLimit ?? defaultRateLimitDetector;

  const runSpawn: RunSpawn =
    opts.runSpawn ??
    (async (intent: ProviderShuttleIntent, cloneDir: string, signal?: AbortSignal): Promise<RunSpawnResult> => {
      const claudeArgs = buildClaudeArgs(intent, permissionMode, opts.max_turns);
      if (opts.strict_mcp === true) {
        claudeArgs.push("--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
      }
      const dockerArgs = buildDockerArgs(
        {
          image: opts.image,
          cloneDir,
          ...(user !== undefined ? { user } : {}),
          ...(opts.home !== undefined ? { home: opts.home } : {}),
          ...(opts.network !== undefined ? { network: opts.network } : {}),
          oauthTokenEnv: opts.oauth_token !== undefined && opts.oauth_token !== "",
          ...(opts.cred_file !== undefined ? { credFileMount: opts.cred_file } : {}),
          ...(opts.extra_mounts !== undefined ? { extraMounts: opts.extra_mounts } : {}),
        },
        [claudeBin, ...claudeArgs],
      );
      const childEnv =
        opts.oauth_token !== undefined && opts.oauth_token !== ""
          ? { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: opts.oauth_token }
          : undefined;
      const { stdout, stderr, exitCode } = await spawnCapture({
        bin: dockerBin,
        args: dockerArgs,
        label: "docker run (claude -p)",
        notFoundMessage:
          `Docker CLI '${dockerBin}' was not found or its daemon is unreachable; ` +
          `install/start Docker to run the container-isolation backend, or run without --docker`,
        detectRateLimit,
        ...(opts.session_timeout_ms !== undefined ? { session_timeout_ms: opts.session_timeout_ms } : {}),
        ...(opts.idle_timeout_ms !== undefined ? { idle_timeout_ms: opts.idle_timeout_ms } : {}),
        ...(childEnv !== undefined ? { env: childEnv } : {}),
        ...(signal !== undefined ? { signal } : {}),
      });
      const output = parseClaudeResult(stdout, detectRateLimit, { stderr, exitCode });
      const usage = parseClaudeUsage(stdout);
      return usage !== undefined ? { output, usage } : { output };
    });

  return createSandboxedExecutor({
    project_dir: opts.project_dir,
    runSpawn,
    provision: () => provisionClone(opts.project_dir),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.onNotice !== undefined ? { onNotice: opts.onNotice } : {}),
    ...(opts.onUsage !== undefined ? { onUsage: opts.onUsage } : {}),
    ...(opts.idempotent !== undefined ? { idempotent: opts.idempotent } : {}),
  });
}
