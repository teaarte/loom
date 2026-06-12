// `createAiderExecutor` — the headless backend that runs a WORK-agent (one
// that edits files) through the Aider CLI, inside the isolated worktree the
// sandboxed-executor shell provisions.
//
// Why this backend exists: the plain provider executor (`createProviderExecutor`)
// makes ONE model call and returns the text — right for a decision-agent, but a
// work-agent needs a tool loop (read / write / shell, iterate to a working
// change). Claude Code gives that loop for free; a raw provider call does not.
// Aider is a maintained, model-AGNOSTIC agentic CLI (one adapter fronts
// anthropic / openai / google / openrouter / ollama via `--model`), so it
// supplies the loop for every non-Claude backend behind the SAME `Executor`
// seam as `claude -p`. loom does NOT write a loop here — Aider IS the loop;
// this module only shells out and maps the result.
//
// It is a sibling of `createClaudeCodeExecutor` over the SAME sandboxed-executor
// shell: it injects an Aider `runSpawn` instead of a `claude` one, and reuses
// the shell's worktree provision + `gitDelta` self-diff + reuse verbatim. So the
// honest file delta that drives the change-conditional reviewers is fed natively
// — no dependence on Aider to report what it touched. ZERO kernel change; the
// loop stays bundle/infra-blind.
//
// Headless posture (spike-confirmed against Ollama): `--message` drives a single
// non-interactive turn, `--yes-always` answers every confirmation, and the
// agent's edits land in the worktree. Aider's scratch files (chat / input / llm
// history) are redirected OUT of the worktree and the repo-map cache is disabled
// (`--map-tokens 0`), so they never pollute the self-diff; auto-commit is off so
// edits stay in the working tree the self-diff measures. Credentials ride in the
// child env by the existing per-family convention (the caller injects them).
//
// Aider has NO JSON envelope (unlike `claude -p`): the agent output IS its
// stdout, success is the exit code, and usage/cost are a best-effort regex over
// its `Tokens:` / `Cost:` summary lines (never a failure path). The shared
// `spawnCapture` seam owns the timeouts + the rate-limit classification.
//
// No npm dependency: it shells out to the external `aider` binary, the same
// posture as shelling to `claude`.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderShuttleIntent } from "@loomfsm/kernel";

import type { Executor, SpawnUsage } from "./drive.js";
import { defaultRateLimitDetector, type RateLimitDetector } from "./rate-limit.js";
import {
  createSandboxedExecutor,
  type ExpectsEdits,
  type RunSpawn,
  type RunSpawnResult,
} from "./sandboxed-executor.js";
import { spawnCapture } from "./spawn-cli.js";

export interface AiderExecutorOptions {
  project_dir: string;
  // The CLI to invoke. Default "aider" (resolved on PATH).
  aider_bin?: string;
  // Map a spawn intent → the Aider `--model` string in litellm form
  // (`openrouter/<model>`, `ollama_chat/<model>`, `anthropic/<model>`, …). The
  // transport (the CLI dispatcher) builds this from the agent's configured
  // `provider:model` ref, since the family→litellm-prefix mapping is a
  // backend/provider concern, not the executor's. Default: the intent's resolved
  // model verbatim (enough for a standalone caller that already passes a
  // litellm-form model).
  resolveModel?: (intent: ProviderShuttleIntent) => string;
  // Child environment for the aider process — where the resolved provider
  // credential rides (e.g. OPENROUTER_API_KEY / OLLAMA_API_BASE) by convention,
  // so the key never lands on argv. Omitted → inherits the parent env.
  env?: NodeJS.ProcessEnv;
  // Aider repo-map token budget (`--map-tokens`). Default 0 — the repo map is
  // disabled so its `.aider.tags.cache.*` never lands in the worktree and
  // pollutes the self-diff; loom prompts already carry the file paths the agent
  // needs. A deployment that wants Aider's own file discovery raises this (and
  // accepts excluding the cache from the delta).
  map_tokens?: number;
  // Extra raw args appended to every aider invocation (escape hatch for
  // deployment-specific flags). Kept behind the caller, never in shared code.
  extra_args?: string[];
  // Kill an aider run whose whole turn exceeds this wall-time → EXECUTOR_TIMEOUT
  // (transient → re-drive). Omitted → no session cap.
  session_timeout_ms?: number;
  // Kill an aider run that emits no output for this long → EXECUTOR_IDLE_TIMEOUT
  // (transient → re-drive). Omitted → no idle cap.
  idle_timeout_ms?: number;
  // Recognise a sustained rate-limit / quota in the finished run →
  // EXECUTOR_RATE_LIMITED (the supervisor waits, never escalates). Injectable;
  // default reads the shared text/status detector over the captured streams.
  detectRateLimit?: RateLimitDetector;
  // Aborts an in-flight aider run when the drive is cancelled.
  signal?: AbortSignal;
  // Sink for the shell's degraded-mode notice.
  onNotice?: (message: string) => void;
  // Sink for per-spawn usage parsed from aider's summary lines. Surfaced for
  // audit; not persisted by the loop (the figures are display-rounded).
  onUsage?: (usage: SpawnUsage) => void;
  // Test seam: inject the per-spawn runner instead of spawning the real binary,
  // so the shell (worktree + self-diff) can be exercised offline.
  runSpawn?: RunSpawn;
  // Predicate forwarded to the shell's empty-diff guard: does this spawn's agent
  // edit project files? A work-agent run through Aider always does, but the
  // transport supplies it per spawn so the shell stays domain-blind. Omitted →
  // no empty-diff check (the shell's default).
  expects_edits?: ExpectsEdits;
}

// Build the argv for one aider invocation. Pure → unit-tested directly.
//
// `--message` runs a single non-interactive turn and exits; `--yes-always`
// answers every confirmation; auto-commit + repo-map + gitignore-editing +
// update-check + analytics are OFF so the run is hermetic and the worktree
// self-diff stays honest. The chat / input / llm history files are redirected
// to `scratchDir` (outside the worktree) for the same reason. A `system_prompt`
// (Aider has no `--append-system-prompt`) is folded into the message so the
// bundle's persona still rides.
//
// `--no-detect-urls` + `--disable-playwright` are load-bearing under
// `--yes-always`: by default Aider scans the message for URLs and, on a match,
// SCRAPES the page — and `--yes-always` then auto-approves installing Playwright
// (a pip + headless-chromium download) to do it. A task description routinely
// contains a URL (an endpoint to change, an internal/prod host), so unattended
// loom would fetch arbitrary hosts and pull a heavyweight dependency without a
// human in the loop. loom feeds the agent every file it needs explicitly; it
// never wants Aider's own URL fetching. Both are real aider flags
// (`AIDER_DETECT_URLS` / `AIDER_DISABLE_PLAYWRIGHT`).
// The message aider is given: the bundle's persona (aider has no
// `--append-system-prompt`) folded ahead of the task prompt. Pure → unit-tested.
export function aiderMessage(intent: ProviderShuttleIntent): string {
  return intent.system_prompt !== undefined && intent.system_prompt !== ""
    ? `${intent.system_prompt}\n\n${intent.prompt}`
    : intent.prompt;
}

export function buildAiderArgs(
  model: string,
  opts: { mapTokens: number; scratchDir: string; messageFile: string; extraArgs?: string[] },
): string[] {
  const args = [
    "--model",
    model,
    // The message is read from a FILE (written into the scratch dir, OUT of the
    // worktree) rather than `--message <text>`, so the task prompt + persona never
    // appear in `ps aux`.
    "--message-file",
    opts.messageFile,
    "--yes-always",
    "--no-stream",
    "--no-pretty",
    "--no-auto-commits",
    "--no-gitignore",
    "--no-check-update",
    "--analytics-disable",
    "--no-show-model-warnings",
    // Under --yes-always these stop Aider from auto-scraping URLs in the task
    // text and auto-installing Playwright (pip + chromium) to do it.
    "--no-detect-urls",
    "--disable-playwright",
    "--map-tokens",
    String(opts.mapTokens),
    "--chat-history-file",
    join(opts.scratchDir, "chat.md"),
    "--input-history-file",
    join(opts.scratchDir, "input"),
    "--llm-history-file",
    join(opts.scratchDir, "llm"),
  ];
  for (const a of opts.extraArgs ?? []) args.push(a);
  return args;
}

function finiteNumber(v: number): number | undefined {
  return Number.isFinite(v) ? v : undefined;
}

// Expand aider's display-abbreviated token counts ("2.4k" → 2400, "1.1M" →
// 1_100_000) into integers. Best-effort: a plain number passes through.
function expandCount(num: string, suffix: string): number {
  const n = Number(num);
  if (!Number.isFinite(n)) return 0;
  const mult = /m/i.test(suffix) ? 1_000_000 : /k/i.test(suffix) ? 1_000 : 1;
  return Math.round(n * mult);
}

// Parse per-spawn usage from aider's stdout summary lines — e.g.
// `Tokens: 2.4k sent, 51 received.` and (for paid models) `Cost: $0.0012 message,
// $0.0150 session.`. Token counts are display-rounded, so they are observability
// figures, not exact accounting. Returns undefined when no line matches (so
// nothing is invented). Never throws — usage is best-effort, never a failure path.
export function parseAiderUsage(stdout: string): SpawnUsage | undefined {
  const usage: SpawnUsage = {};

  const tok = /tokens?:\s*([\d.]+)\s*([km]?)\s*sent,\s*([\d.]+)\s*([km]?)\s*received/i.exec(stdout);
  if (tok !== null) {
    const inTok = expandCount(tok[1] ?? "", tok[2] ?? "");
    const outTok = expandCount(tok[3] ?? "", tok[4] ?? "");
    usage.tokens = { in: inTok, out: outTok };
  }

  const cost = /cost:\s*\$?([\d.]+)/i.exec(stdout);
  if (cost !== null) {
    const c = finiteNumber(Number(cost[1]));
    if (c !== undefined) usage.cost_usd = c;
  }

  return Object.keys(usage).length > 0 ? usage : undefined;
}

interface SpawnAiderOptions {
  session_timeout_ms?: number;
  idle_timeout_ms?: number;
  detectRateLimit: RateLimitDetector;
  env?: NodeJS.ProcessEnv;
}

async function spawnAider(
  bin: string,
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  capture: SpawnAiderOptions,
): Promise<RunSpawnResult> {
  const { stdout } = await spawnCapture({
    bin,
    args,
    cwd,
    label: "aider",
    notFoundMessage:
      `Aider CLI '${bin}' was not found; install it (e.g. 'uv tool install aider-chat' or ` +
      `'pipx install aider-chat') to run work-agents headless on a non-Claude backend`,
    detectRateLimit: capture.detectRateLimit,
    ...(capture.env !== undefined ? { env: capture.env } : {}),
    ...(capture.session_timeout_ms !== undefined ? { session_timeout_ms: capture.session_timeout_ms } : {}),
    ...(capture.idle_timeout_ms !== undefined ? { idle_timeout_ms: capture.idle_timeout_ms } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });
  // Aider has no structured envelope: stdout IS the agent output, the exit code
  // (handled by spawnCapture) is success. Usage is a best-effort parse.
  const output = stdout.trim();
  const usage = parseAiderUsage(stdout);
  return usage !== undefined ? { output, usage } : { output };
}

export function createAiderExecutor(opts: AiderExecutorOptions): Executor {
  const bin = opts.aider_bin ?? "aider";
  const mapTokens = opts.map_tokens ?? 0;
  const detectRateLimit = opts.detectRateLimit ?? defaultRateLimitDetector;
  const resolveModel = opts.resolveModel ?? ((intent) => intent.model);
  // One scratch dir per executor instance, OUTSIDE the worktree, for aider's
  // history files (so they never show up in the self-diff). Ambient I/O is fine
  // — this is transport runtime outside the kernel's replay graph.
  let scratchDir: string | null = null;
  const scratch = (): string => {
    if (scratchDir === null) scratchDir = mkdtempSync(join(tmpdir(), "loom-aider-"));
    return scratchDir;
  };

  const runSpawn: RunSpawn =
    opts.runSpawn ??
    ((intent, worktreeDir, signal) => {
      // Write the message to a file in the scratch dir (OUT of the worktree) and
      // pass it via `--message-file`, so the prompt + persona stay off argv.
      const messageFile = join(scratch(), "message.txt");
      writeFileSync(messageFile, aiderMessage(intent), "utf8");
      return spawnAider(
        bin,
        buildAiderArgs(resolveModel(intent), {
          mapTokens,
          scratchDir: scratch(),
          messageFile,
          ...(opts.extra_args !== undefined ? { extraArgs: opts.extra_args } : {}),
        }),
        worktreeDir,
        signal,
        {
          detectRateLimit,
          ...(opts.env !== undefined ? { env: opts.env } : {}),
          ...(opts.session_timeout_ms !== undefined ? { session_timeout_ms: opts.session_timeout_ms } : {}),
          ...(opts.idle_timeout_ms !== undefined ? { idle_timeout_ms: opts.idle_timeout_ms } : {}),
        },
      );
    });

  return createSandboxedExecutor({
    project_dir: opts.project_dir,
    runSpawn,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.onNotice !== undefined ? { onNotice: opts.onNotice } : {}),
    ...(opts.onUsage !== undefined ? { onUsage: opts.onUsage } : {}),
    ...(opts.expects_edits !== undefined ? { expects_edits: opts.expects_edits } : {}),
  });
}
