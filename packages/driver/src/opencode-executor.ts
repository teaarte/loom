// `createOpencodeExecutor` — a work-agent backend that runs an AGENTIC agent
// (one that edits files) through the opencode CLI, inside the isolated worktree
// the sandboxed-executor shell provisions. Sibling of `createAiderExecutor`: a
// different model-agnostic agentic CLI behind the SAME seam.
//
// opencode is model-agnostic (one adapter fronts anthropic / openai / google /
// openrouter / a local Ollama via `-m provider/model`) and brings its own tool
// loop + edit tools — so loom writes no loop here; opencode IS the loop. loom
// contributes the git-worktree isolation + the honest self-diff (via the shared
// shell), exactly as for `claude -p` and aider.
//
// Headless posture (spike-confirmed): `opencode run --format json
// --dangerously-skip-permissions -m <model> "<message>"` runs a single
// non-interactive turn and exits; auto-approve lets edits land without a prompt.
// Unlike aider, opencode keeps its session/history in its OWN data dir (not the
// project), so there are NO scratch files to redirect out of the worktree — the
// self-diff stays clean with no extra flags.
//
// opencode's `--format json` emits an NDJSON event stream: `text` parts carry
// the assistant's narration (joined into agent_output) and `step-finish` parts
// carry per-step `tokens` + `cost` (summed into usage, best-effort). Success is
// the exit code (handled by `spawnCapture`). Credentials ride in the child env
// by the existing per-family convention (the caller injects them); a local
// Ollama is configured in the user's `opencode.json`, the same way a user
// configures opencode normally — loom does not synthesize it.
//
// No npm dependency: it shells out to the external `opencode` binary.

import type { ProviderShuttleIntent } from "@loomfsm/kernel";

import type { Executor, SpawnUsage } from "./drive.js";
import { defaultRateLimitDetector, type RateLimitDetector } from "./rate-limit.js";
import { createSandboxedExecutor, type RunSpawn, type RunSpawnResult } from "./sandboxed-executor.js";
import { spawnCapture } from "./spawn-cli.js";

export interface OpencodeExecutorOptions {
  project_dir: string;
  // The CLI to invoke. Default "opencode" (resolved on PATH).
  opencode_bin?: string;
  // Map a spawn intent → the opencode `-m` model string (`provider/model`). The
  // transport builds this from the agent's configured ref. Default: the intent's
  // resolved model verbatim.
  resolveModel?: (intent: ProviderShuttleIntent) => string;
  // Child environment for the opencode process — where the resolved provider
  // credential rides (e.g. OPENROUTER_API_KEY) by convention. Omitted → inherits
  // the parent env.
  env?: NodeJS.ProcessEnv;
  // Extra raw args appended to every opencode invocation.
  extra_args?: string[];
  // Wall-time / idle caps (kill a wedged run → transient EXECUTOR_*_TIMEOUT).
  session_timeout_ms?: number;
  idle_timeout_ms?: number;
  // Recognise a sustained rate-limit → EXECUTOR_RATE_LIMITED. Injectable; default
  // reads the shared text/status detector over the captured streams.
  detectRateLimit?: RateLimitDetector;
  signal?: AbortSignal;
  onNotice?: (message: string) => void;
  onUsage?: (usage: SpawnUsage) => void;
  // Test seam: inject the per-spawn runner instead of spawning the real binary.
  runSpawn?: RunSpawn;
}

// Build the argv for one opencode invocation. Pure → unit-tested directly.
// `run` is the non-interactive subcommand; `--format json` gives the parseable
// event stream; `--dangerously-skip-permissions` auto-approves edits (safe — the
// run is confined to the worktree the shell provisions). A `system_prompt`
// (opencode `run` has no system-prompt flag) is folded into the message.
export function buildOpencodeArgs(
  intent: ProviderShuttleIntent,
  model: string,
  opts: { dir?: string; extraArgs?: string[] } = {},
): string[] {
  const message =
    intent.system_prompt !== undefined && intent.system_prompt !== ""
      ? `${intent.system_prompt}\n\n${intent.prompt}`
      : intent.prompt;
  const args = [
    "run",
    "--format",
    "json",
    "--dangerously-skip-permissions",
    "-m",
    model,
  ];
  // Pin the project dir EXPLICITLY to the isolated worktree. opencode otherwise
  // resolves its project / git-snapshot root from the launching PROCESS cwd, not
  // the child's spawn cwd — so without this it edits the parent repo (the dir the
  // driver was started from) instead of the worktree, breaking isolation. `--dir`
  // is opencode's own "run in this directory" flag and overrides that.
  if (opts.dir !== undefined && opts.dir !== "") {
    args.push("--dir", opts.dir);
  }
  for (const a of opts.extraArgs ?? []) args.push(a);
  // The message is the trailing positional (after flags + their values).
  args.push(message);
  return args;
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// Parse opencode's `--format json` NDJSON stream. Returns the assistant text
// (joined `text` parts) plus best-effort usage summed from `step-finish` parts.
// Tolerant: non-JSON lines and unknown event shapes are skipped (never throws —
// the exit code, not the parse, decides success). When no text part is present,
// the raw stdout is the output (so nothing is lost).
export function parseOpencodeResult(stdout: string): { output: string; usage?: SpawnUsage } {
  const texts: string[] = [];
  let inTok = 0;
  let outTok = 0;
  let cachedTok = 0;
  let cost = 0;
  let sawTokens = false;
  let sawCost = false;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed[0] !== "{") continue;
    let ev: unknown;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof ev !== "object" || ev === null) continue;
    const obj = ev as { type?: unknown; part?: unknown };
    const part = (typeof obj.part === "object" && obj.part !== null ? obj.part : {}) as Record<
      string,
      unknown
    >;
    if (obj.type === "text" && typeof part["text"] === "string") {
      texts.push(part["text"]);
    } else if (obj.type === "step_finish" || obj.type === "step-finish") {
      const tokens = part["tokens"];
      if (typeof tokens === "object" && tokens !== null) {
        const t = tokens as Record<string, unknown>;
        const i = finiteNumber(t["input"]);
        const o = finiteNumber(t["output"]);
        if (i !== undefined) {
          inTok += i;
          sawTokens = true;
        }
        if (o !== undefined) {
          outTok += o;
          sawTokens = true;
        }
        const cache = t["cache"];
        if (typeof cache === "object" && cache !== null) {
          const cr = finiteNumber((cache as Record<string, unknown>)["read"]);
          if (cr !== undefined) cachedTok += cr;
        }
      }
      const c = finiteNumber(part["cost"]);
      if (c !== undefined) {
        cost += c;
        sawCost = true;
      }
    }
  }

  const output = texts.length > 0 ? texts.join("\n").trim() : stdout.trim();
  let usage: SpawnUsage | undefined;
  if (sawTokens || sawCost) {
    usage = {};
    if (sawTokens) usage.tokens = { in: inTok, out: outTok, ...(cachedTok > 0 ? { cached: cachedTok } : {}) };
    if (sawCost) usage.cost_usd = cost;
  }
  return usage !== undefined ? { output, usage } : { output };
}

interface SpawnOpencodeOptions {
  session_timeout_ms?: number;
  idle_timeout_ms?: number;
  detectRateLimit: RateLimitDetector;
  env?: NodeJS.ProcessEnv;
}

async function spawnOpencode(
  bin: string,
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  capture: SpawnOpencodeOptions,
): Promise<RunSpawnResult> {
  const stdout = await spawnCapture({
    bin,
    args,
    cwd,
    label: "opencode run",
    notFoundMessage:
      `opencode CLI '${bin}' was not found; install it (e.g. 'npm install -g opencode-ai' or ` +
      `'brew install sst/tap/opencode') to run work-agents headless on a non-Claude backend`,
    detectRateLimit: capture.detectRateLimit,
    ...(capture.env !== undefined ? { env: capture.env } : {}),
    ...(capture.session_timeout_ms !== undefined ? { session_timeout_ms: capture.session_timeout_ms } : {}),
    ...(capture.idle_timeout_ms !== undefined ? { idle_timeout_ms: capture.idle_timeout_ms } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });
  return parseOpencodeResult(stdout);
}

export function createOpencodeExecutor(opts: OpencodeExecutorOptions): Executor {
  const bin = opts.opencode_bin ?? "opencode";
  const detectRateLimit = opts.detectRateLimit ?? defaultRateLimitDetector;
  const resolveModel = opts.resolveModel ?? ((intent) => intent.model);

  const runSpawn: RunSpawn =
    opts.runSpawn ??
    ((intent, worktreeDir, signal) =>
      spawnOpencode(
        bin,
        buildOpencodeArgs(intent, resolveModel(intent), {
          dir: worktreeDir,
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
      ));

  return createSandboxedExecutor({
    project_dir: opts.project_dir,
    runSpawn,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.onNotice !== undefined ? { onNotice: opts.onNotice } : {}),
    ...(opts.onUsage !== undefined ? { onUsage: opts.onUsage } : {}),
  });
}
