// `loom serve [--project <dir>]... [--host] [--port] [--token] [--detach]` —
// the network control plane: one long-lived process that supervises a FLEET of
// projects (each over the SAME headless loop `loom run` / `loom daemon` drive)
// and exposes them over HTTP on loopback, so a dashboard, a chat bot, or an
// issue poller can submit a task, read status, and answer a gate.
//
//   serve [--project <dir>]... [--host h] [--port p] [--token t] [--detach]
//       Start the control plane. Re-attaches every durably-registered project,
//       plus each --project. --detach forks a background server and returns.
//       A token (flag or LOOM_SERVER_TOKEN) makes every API route require
//       `Authorization: Bearer <token>`.
//   serve stop       Signal a running control plane to stop gracefully.
//   serve status     Show whether it is running, where it binds, and how many
//                    projects it supervises.
//
// Subscription, not API key: like `loom run`/`loom daemon`, each spawn runs
// through `claude -p` on the user's Claude Code login. This command is a thin
// wrapper that injects the production registry resolver + the `claude -p`
// executor factory exactly as those do; all logic lives in @loomfsm/server.

import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { resolveLoomHome } from "@loomfsm/config";
import type { ExecutorBuildContext, MergeBackResult, Notifier } from "@loomfsm/daemon";
import type { DriveOutcome, Executor } from "@loomfsm/driver";
import type { Registry } from "@loomfsm/kernel";
import type { ControlPlaneHandle, ControlPlaneOptions } from "@loomfsm/server";

import { effectiveEnv } from "../lib/config.js";
import { containerModeFrom, resolveContainerPlan, type ContainerMode, type ContainerPlan } from "../lib/container.js";
import { buildDispatchExecutor } from "../lib/dispatch.js";
import { reloadableNotifier, resolveNotifier } from "../lib/notify.js";
import { resolveSpawnTimeouts, resolveSupervisionKnobs } from "../lib/resilience.js";
import type { CliEnv } from "../lib/env.js";

type CompleteOutcome = Extract<DriveOutcome, { kind: "complete" }>;
type ServeMergeBack = (
  projectDir: string,
  outcome: CompleteOutcome,
) => MergeBackResult | Promise<MergeBackResult>;
type ServeFactory = {
  buildExecutor: (projectDir: string, ctx: ExecutorBuildContext) => Executor;
  mergeBack?: ServeMergeBack;
  // Whether a `docker:true` submit can be honoured — surfaced to the control
  // plane for `GET /providers` + the submit-time refusal.
  dockerCapability?: () => { available: boolean; reason?: string };
};

// Test seams — a suite injects a ready registry / executor factory / a fake
// startControlPlane / an injected shutdown signal so it can assert parsing +
// reporting + lifecycle wiring without standing up the Claude Code CLI or Docker.
export interface ServeOverrides {
  resolveRegistry?: (projectDir: string) => Promise<Registry> | Registry;
  buildExecutor?: (projectDir: string, ctx: ExecutorBuildContext) => Executor;
  claudeAvailable?: (bin: string) => boolean;
  dockerAvailable?: () => boolean;
  // Stand in for `startControlPlane` (a test injects a fake so it can assert
  // parsing + reporting + lifecycle without binding a socket or standing up the
  // Claude Code CLI). Production resolves the real implementation.
  startImpl?: (opts: ControlPlaneOptions) => Promise<ControlPlaneHandle>;
  // Invoked once the control plane is listening, with its base URL — the seam
  // `loom up` uses to open a browser. Production `serve` leaves it unset.
  onListening?: (url: string) => void;
  stateDir?: string;
  signal?: AbortSignal;
  // Bust the registry-routing cache after a config write (test seam; production
  // wires the bootstrap resolver).
  invalidateRegistry?: (projectDir?: string) => void;
}

interface ServeFlags {
  projects: string[];
  host?: string;
  port?: number;
  token?: string;
  detach: boolean;
  docker: boolean;
  noDocker: boolean;
  unknown?: string;
  badPort?: string;
}

export async function serve(argv: string[], env: CliEnv, overrides: ServeOverrides = {}): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
    case "start":
      return await start(sub === undefined ? argv : rest, env, overrides);
    case "stop":
      return await stop(env, overrides);
    case "status":
      return await serveStatus(env, overrides);
    default:
      // No subcommand keyword → treat the whole argv as `start` flags.
      if (sub.startsWith("-")) return await start(argv, env, overrides);
      env.err(`loom serve: expected 'start', 'stop', or 'status', got ${sub}`);
      env.err("run 'loom --help' for usage");
      return 1;
  }
}

async function start(argv: string[], env: CliEnv, overrides: ServeOverrides): Promise<number> {
  const flags = parseServeFlags(argv);
  if (flags.unknown !== undefined) {
    env.err(`loom serve: unknown flag ${flags.unknown}`);
    return 1;
  }
  if (flags.badPort !== undefined) {
    env.err(`loom serve: invalid --port '${flags.badPort}'`);
    return 1;
  }

  const modeResult = containerModeFrom({ docker: flags.docker, noDocker: flags.noDocker });
  if ("error" in modeResult) {
    env.err(`loom serve: ${modeResult.error}`);
    return 1;
  }

  // Relocate any legacy `~/.claude/` operator files (allowlist, hmac key,
  // server state) into `~/.loom/` before the control plane reads its state dir.
  // `serve` re-execs with the SQLite flag, so the dynamic kernel import is safe
  // here even though a static one would not be (it would poison flag-free
  // commands in the eager import chain).
  (await import("@loomfsm/kernel")).userFootprintDir(env.home.length > 0 ? env.home : homedir());

  const stateDir = resolveStateDir(env, overrides);
  const token = flags.token ?? envToken();
  const host = flags.host ?? process.env["LOOM_SERVER_HOST"];
  const port = flags.port ?? envPort();
  const projects = flags.projects.map((p) => resolve(env.cwd, p));

  if (flags.detach) {
    return detach(argv, env);
  }

  // Fold the persisted config in as a lower-priority env layer (the real
  // environment still wins). The control plane has no single project, so the
  // project layer is the operator's cwd; the global notify + resilience are what
  // a fleet reads.
  //
  // `cfgEnvCell` re-resolves the overlay (re-reading config.json) on each call —
  // the reloadable config cell. The notifier + the config-API routes read it LIVE
  // so a `loom config`/`secrets` edit applies without a restart. The watcher-
  // scoped knobs below (container plan + supervision + timeouts) take a one-time
  // SNAPSHOT — they are read once at attach and documented as not hot-reloaded.
  const cfgEnvCell = (): NodeJS.ProcessEnv => effectiveEnv(env.cwd, env, process.env);
  const cfgEnv = cfgEnvCell();

  // Resolve the production registry resolver + the per-project executor factory
  // (container or `claude -p` worktree, per the toggle), mirroring `loom run` /
  // `loom daemon`.
  const resolveRegistry =
    overrides.resolveRegistry ?? (await import("@loomfsm/mcp-server/bootstrap")).assembleRegistry;

  let factory: ServeFactory;
  try {
    factory = overrides.buildExecutor
      ? { buildExecutor: overrides.buildExecutor }
      : await defaultServeFactory(env, modeResult.mode, overrides, cfgEnv, resolveRegistry);
  } catch (err) {
    env.err(`loom serve: ${(err as Error).message}`);
    return 1;
  }

  const startControlPlane = overrides.startImpl ?? (await import("@loomfsm/server")).startControlPlane;
  const { createFileLogger } = await import("@loomfsm/daemon");

  // The reloadable fleet notifier: built once per project but re-resolves its
  // channels from the LIVE config overlay, so a notify edit applies on the next
  // event. Always wired (even with no channel configured today) so configuring one
  // mid-run takes effect without a restart. The registry stamps each project's id.
  const makeNotifier = (): Notifier =>
    reloadableNotifier(cfgEnvCell, (e) => resolveNotifier(e, (m) => env.err(`loom serve: notify: ${m}`)));

  // The config-API surface: the resolved global home + the live env cell so the
  // routes read/write the SAME stores the CLI does, plus a CC probe for
  // `GET /providers` and a registry-cache bust so a model edit lands next spawn.
  const loomHome = resolveLoomHome(process.env, env.home);
  const ccBin = cfgEnv["LOOM_CLAUDE_BIN"] ?? "claude";
  const claudeProbe = (): boolean => (overrides.claudeAvailable ?? claudeAvailable)(ccBin);
  const invalidateRegistry =
    overrides.invalidateRegistry ?? (await import("@loomfsm/mcp-server/bootstrap")).invalidateRegistry;

  // Graceful shutdown: a test injects a signal; the real binary wires OS signals.
  const controller = new AbortController();
  const usingInjected = overrides.signal !== undefined;
  const signal = overrides.signal ?? controller.signal;
  const onSignal = (): void => controller.abort();
  if (!usingInjected) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }

  try {
    const handle = await startControlPlane({
      stateDir,
      ...(host !== undefined ? { host } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(token !== undefined && token.length > 0 ? { token } : {}),
      projects,
      resolveRegistry,
      buildExecutor: factory.buildExecutor,
      ...(factory.mergeBack !== undefined ? { mergeBack: factory.mergeBack } : {}),
      ...(factory.dockerCapability !== undefined ? { dockerCapability: factory.dockerCapability } : {}),
      ...resolveSupervisionKnobs(cfgEnv),
      makeLogger: (dir: string) => createFileLogger(dir, { echo: () => {} }),
      makeNotifier,
      loomHome,
      configEnv: cfgEnvCell,
      invalidateRegistry,
      claudeAvailable: claudeProbe,
      signal,
      serverLog: (line: string) => env.err(line),
    });

    env.out(`loom serve: control plane on http://${handle.host}:${handle.port}`);
    env.out(`  supervising ${handle.attached.length} project(s)${token !== undefined && token.length > 0 ? " [token required]" : ""}`);
    for (const p of handle.attached) env.out(`    - ${p.id}  ${p.dir}`);
    const url = `http://${handle.host}:${handle.port}/`;
    env.out(`  dashboard: ${url}   |   stop: 'loom serve stop'`);

    overrides.onListening?.(url);

    await handle.closed;
    env.out("loom serve: stopped");
    return 0;
  } catch (err) {
    env.err(`loom serve: ${(err as Error).message}`);
    return 1;
  } finally {
    if (!usingInjected) {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  }
}

async function stop(env: CliEnv, overrides: ServeOverrides): Promise<number> {
  const stateDir = resolveStateDir(env, overrides);
  const { signalServerStop } = await import("@loomfsm/server");
  const result = signalServerStop(stateDir);
  if (result === "signalled") {
    env.out("loom serve: stop signalled");
    return 0;
  }
  env.out("loom serve: no running control plane");
  return 0;
}

async function serveStatus(env: CliEnv, overrides: ServeOverrides): Promise<number> {
  const stateDir = resolveStateDir(env, overrides);
  const { readServerStatus } = await import("@loomfsm/server");
  const { isAlive } = await import("@loomfsm/daemon");
  const status = readServerStatus(stateDir);
  if (status === null || !isAlive(status.pid)) {
    env.out("loom serve: not running");
    if (status !== null) env.out(`  (a stale status file from pid ${status.pid} remains)`);
    return 0;
  }
  env.out(`loom serve: running (pid ${status.pid})`);
  env.out(`  bind:     http://${status.host}:${status.port}`);
  env.out(`  phase:    ${status.phase}`);
  env.out(`  projects: ${status.project_count}`);
  env.out(`  started:  ${status.started_at}`);
  env.out(`  updated:  ${status.updated_at}`);
  return 0;
}

// ----- internals ---------------------------------------------------------

function parseServeFlags(argv: string[]): ServeFlags {
  const out: ServeFlags = { projects: [], detach: false, docker: false, noDocker: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--project" || a === "-p") {
      const v = argv[++i];
      if (v !== undefined && v.length > 0) out.projects.push(v);
    } else if (a === "--host") {
      out.host = argv[++i];
    } else if (a === "--port") {
      const v = argv[++i];
      const n = v !== undefined ? Number(v) : NaN;
      if (!Number.isInteger(n) || n < 0 || n > 65535) out.badPort = v ?? "(missing)";
      else out.port = n;
    } else if (a === "--token") {
      out.token = argv[++i];
    } else if (a === "--detach") {
      out.detach = true;
    } else if (a === "--docker") {
      out.docker = true;
    } else if (a === "--no-docker") {
      out.noDocker = true;
    } else if (a.startsWith("-")) {
      out.unknown = a;
      return out;
    }
    // bare positionals are ignored — serve takes no task
  }
  return out;
}

function resolveStateDir(env: CliEnv, overrides: ServeOverrides): string {
  if (overrides.stateDir !== undefined) return overrides.stateDir;
  const fromEnv = process.env["LOOM_SERVER_STATE_DIR"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const home = env.home.length > 0 ? env.home : homedir();
  // Mirror the kernel's `userFootprintDir(home) + "server"` without importing
  // the kernel here — `serve` sits in the launcher's eager import chain, so a
  // static kernel import would pull `node:sqlite` into every flag-free command.
  // The legacy `~/.claude/loom-server` is relocated by the migration trigger in
  // `serve()` before the control plane reads this dir.
  return resolve(home, ".loom", "server");
}

function envToken(): string | undefined {
  const t = process.env["LOOM_SERVER_TOKEN"];
  return t !== undefined && t.length > 0 ? t : undefined;
}

function envPort(): number | undefined {
  const p = process.env["LOOM_SERVER_PORT"];
  if (p === undefined || p.length === 0) return undefined;
  const n = Number(p);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : undefined;
}

// The per-project drive factory. The SERVER-WIDE default plan is resolved once
// (per the --docker/--no-docker toggle), and a Docker plan is probed once too,
// so a PER-TASK `docker` choice (the submit-time flag, persisted in the project's
// task-exec sidecar) can pick the right isolation per drive. `planFor` reads that
// sidecar and returns: the Docker plan for a `docker:true` task, a forced
// worktree for `docker:false`, or the server default when unset. Both the
// per-spawn executor AND the merge-back dispatch on it, so a Docker task commits
// from its container clone and a worktree task from its worktree — fleet-wide.
async function defaultServeFactory(
  env: CliEnv,
  mode: ContainerMode,
  overrides: ServeOverrides,
  cfgEnv: NodeJS.ProcessEnv,
  resolveRegistry: (projectDir: string) => Promise<Registry> | Registry,
): Promise<ServeFactory> {
  const home = env.home.length > 0 ? env.home : homedir();
  const dockerAvailable = overrides.dockerAvailable ?? dockerAvailableDefault;
  const defaultPlan = resolveContainerPlan({
    mode,
    env: cfgEnv,
    home,
    dockerAvailable,
    onNotice: (message) => env.err(`loom serve: ${message}`),
  });

  // Probe a Docker plan for per-task opt-in. When the server default is already
  // Docker, reuse it; otherwise resolve a `require`-mode plan with a silent sink
  // (the real per-drive notice fires in buildExecutor) and capture WHY it failed
  // so a `docker:true` submit can refuse with a precise reason.
  let dockerPlan: Extract<ContainerPlan, { useDocker: true }> | null = null;
  let dockerReason: string | undefined;
  if (defaultPlan.useDocker) {
    dockerPlan = defaultPlan;
  } else {
    try {
      const probed = resolveContainerPlan({ mode: "require", env: cfgEnv, home, dockerAvailable, onNotice: () => {} });
      if (probed.useDocker) dockerPlan = probed;
    } catch (err) {
      dockerReason = err instanceof Error ? err.message : String(err);
    }
  }

  const timeouts = resolveSpawnTimeouts(cfgEnv);
  const bin = cfgEnv["LOOM_CLAUDE_BIN"] ?? "claude";
  const available = overrides.claudeAvailable ?? claudeAvailable;
  // The per-agent execution map (single-shot vs agentic) is per-PROJECT here
  // (the bundle is resolved per project), so a work-agent on a non-Claude
  // backend gets the Aider worktree harness. These dynamic imports keep
  // @loomfsm/server (and the heavy daemon/bootstrap) OUT of the eager command
  // graph, so a bare `loom --version` never loads them.
  const { agentExecutionFor } = await import("@loomfsm/mcp-server/bootstrap");
  const { commitToBranchMergeBack, commitToBranchMergeBackFromClone } = await import("@loomfsm/daemon");
  const { readTaskExecPrefs } = await import("@loomfsm/server");

  // The effective plan for a project's CURRENT task: docker:true → the Docker
  // plan (falling back to default without throwing — submit already refused an
  // unavailable request); docker:false → forced worktree; unset → server default.
  const planFor = (projectDir: string): ContainerPlan => {
    const pref = readTaskExecPrefs(projectDir).docker;
    if (pref === true) return dockerPlan ?? defaultPlan;
    if (pref === false) return { useDocker: false };
    return defaultPlan;
  };

  const factory: ServeFactory = {
    buildExecutor: (projectDir, ctx) => {
      const plan = planFor(projectDir);
      if (plan.useDocker) {
        ctx.onNotice(`container isolation active for this task (image ${plan.container.image})`);
      }
      const bundleNameP = Promise.resolve(resolveRegistry(projectDir)).then((r) => r.bundle.name);
      return buildDispatchExecutor({
        projectDir,
        resolveBundleName: () => bundleNameP,
        env: cfgEnv,
        home,
        plan,
        timeouts,
        claudeAvailable: () => available(bin),
        resolveAgentExecution: async (agent) => agentExecutionFor(await bundleNameP)[agent] ?? "single-shot",
        onNotice: ctx.onNotice,
        onUsage: ctx.onUsage,
        signal: ctx.signal,
      });
    },
    // Merge-back dispatches on the SAME per-task plan: a Docker task integrates
    // from its container clone, a worktree task from its worktree. (Each is a
    // no-op when its copy dir is absent, so a mis-dispatch is safe, but matching
    // them keeps the path tight.)
    mergeBack: (dir, outcome) =>
      planFor(dir).useDocker
        ? commitToBranchMergeBackFromClone(dir, outcome.task_id)
        : commitToBranchMergeBack(dir, outcome.task_id),
    dockerCapability: () =>
      dockerPlan !== null
        ? { available: true }
        : { available: false, ...(dockerReason !== undefined ? { reason: dockerReason } : {}) },
  };
  return factory;
}

function claudeAvailable(bin: string): boolean {
  const res = spawnSync(bin, ["--version"], { encoding: "utf8" });
  return res.error === undefined && res.status === 0;
}

function dockerAvailableDefault(): boolean {
  const bin = process.env["LOOM_DOCKER_BIN"] ?? "docker";
  const res = spawnSync(bin, ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
  return res.error === undefined && res.status === 0;
}

// Fork a detached background control plane: re-exec the launcher with the same
// flags, print its pid, and return. The child writes its own server status
// file via the lock, so `serve stop`/`serve status` find it.
function detach(argv: string[], env: CliEnv): number {
  const entry = process.argv[1];
  if (entry === undefined) {
    env.err("loom serve: cannot locate the launcher to detach");
    return 1;
  }
  const passthrough = argv.filter((a) => a !== "--detach");
  const args = ["--experimental-sqlite", "--no-warnings", entry, "serve", ...passthrough];
  const child = spawn(process.execPath, args, {
    cwd: env.cwd,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, LOOM_SQLITE_REEXEC: "1" },
  });
  child.unref();
  env.out(`loom serve: started in background (pid ${child.pid ?? "?"}) — stop with 'loom serve stop'`);
  return 0;
}
