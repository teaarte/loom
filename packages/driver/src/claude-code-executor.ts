// `createClaudeCodeExecutor` — the headless backend that runs each spawn
// through the Claude Code CLI in print mode (`claude -p`), inside the
// isolated worktree the sandboxed-executor shell provisions.
//
// Why this backend: it runs on the user's EXISTING Claude Code login — i.e.
// their subscription (OAuth/keychain) — rather than a raw Anthropic API key.
// The one rule that makes this true: NEVER pass `--bare`. `--bare` forces
// `ANTHROPIC_API_KEY`/apiKeyHelper and explicitly never reads OAuth/keychain;
// the plain invocation reads the existing login, so the run bills against the
// subscription and needs no API key configured in loom.
//
// Claude Code brings its OWN tools, sandbox, permission model, and subagents,
// so this backend needs none of loom's own file/exec tools — the agent acts
// with CC's inventory. loom contributes the git-worktree isolation (via the
// shell) and the honest self-diff; CC contributes tool gating via
// `--permission-mode`.
//
// Safe-default posture: `--permission-mode acceptEdits` lets file edits
// proceed unattended but leaves arbitrary shell GATED (a print-mode run cannot
// answer a permission prompt, so a gated tool is effectively refused). Full
// power is opt-in — the caller raises it to `bypassPermissions` only
// deliberately (the run is confined to a throwaway worktree, but it is never
// the default).
//
// The driver gains NO npm dependency: it shells out to the external `claude`
// binary via node:child_process.

import { KernelError, type ProviderShuttleIntent } from "@loomfsm/kernel";

import type { Executor, SpawnUsage } from "./drive.js";
import { classifyPermanentProviderError, PERMANENT_PROVIDER_ERROR_CODE } from "./provider-error.js";
import { defaultRateLimitDetector, type RateLimitDetector } from "./rate-limit.js";
import { createSandboxedExecutor, type RunSpawn, type RunSpawnResult } from "./sandboxed-executor.js";
import { spawnCapture } from "./spawn-cli.js";

const DEFAULT_PERMISSION_MODE = "acceptEdits";

export interface ClaudeCodeExecutorOptions {
  project_dir: string;
  // The CLI to invoke. Default "claude" (resolved on PATH).
  claude_bin?: string;
  // Claude Code permission mode. Default "acceptEdits" (edits proceed, shell
  // gated). Raise to "bypassPermissions" only deliberately.
  permission_mode?: string;
  // Cap on agentic turns (`claude --max-turns`). Omitted → CC's own default.
  max_turns?: number;
  // Kill a `claude -p` whose whole run exceeds this wall-time → EXECUTOR_TIMEOUT
  // (transient → re-drive). Omitted → no session cap.
  session_timeout_ms?: number;
  // Kill a `claude -p` that emits no output for this long → EXECUTOR_IDLE_TIMEOUT
  // (transient → re-drive). Omitted → no idle cap.
  idle_timeout_ms?: number;
  // Recognise a sustained rate-limit in the finished run → EXECUTOR_RATE_LIMITED
  // (the supervisor waits, never escalates). Injectable; default reads the
  // envelope's `api_error_status` (429) with a text fallback.
  detectRateLimit?: RateLimitDetector;
  // Aborts an in-flight `claude -p` when the drive is cancelled.
  signal?: AbortSignal;
  // Sink for the shell's degraded-mode notice.
  onNotice?: (message: string) => void;
  // Sink for per-spawn usage (tokens / cost) parsed from the `claude -p`
  // JSON envelope. Surfaced for audit; not persisted by the loop.
  onUsage?: (usage: SpawnUsage) => void;
  // Test seam: inject the per-spawn runner instead of spawning the real
  // binary, so the shell (worktree + self-diff) can be exercised offline.
  runSpawn?: RunSpawn;
}

// Build the argv for one `claude -p` invocation. Pure → unit-tested directly.
// Deliberately omits `--bare` so the run uses the subscription login.
export function buildClaudeArgs(
  intent: ProviderShuttleIntent,
  permissionMode: string,
  maxTurns: number | undefined,
): string[] {
  const args = [
    "-p",
    intent.prompt,
    "--output-format",
    "json",
    "--permission-mode",
    permissionMode,
  ];
  // A placeholder model ("default") means "let CC use its configured model";
  // a real alias ("opus"/"sonnet") or full id is forwarded.
  if (intent.model !== "" && intent.model !== "default") {
    args.push("--model", intent.model);
  }
  // Append (not replace) so Claude Code's own tool-use system prompt survives
  // and the agent can still drive CC's tools; the bundle's persona rides on top.
  if (intent.system_prompt !== undefined && intent.system_prompt !== "") {
    args.push("--append-system-prompt", intent.system_prompt);
  }
  if (maxTurns !== undefined) {
    args.push("--max-turns", String(maxTurns));
  }
  return args;
}

// Raw streams the parser folds into a parse-failure error so "why did this
// spawn produce no JSON?" is answerable from the surfaced message alone. The
// capture seam only exposes stderr/exit on a clean (exit-0) run, so a flail
// that exits 0 with non-JSON output still carries its raw output here.
export interface ClaudeParseContext {
  stderr?: string;
  exitCode?: number | null;
}

// Keep head AND tail of a long stream (a truncated JSON envelope starts at the
// front; the final error/message sits at the end), bounded so the message stays
// log-sized.
function rawTail(s: string, head = 1_000, tail = 1_000): string {
  const t = s.trim();
  const max = head + tail;
  if (t.length <= max) return t;
  return `${t.slice(0, head)}\n…[${t.length - max} chars omitted]…\n${t.slice(t.length - tail)}`;
}

function parseFailureMessage(base: string, stdout: string, ctx: ClaudeParseContext | undefined): string {
  const parts = [base];
  const out = stdout.trim();
  if (out.length > 0) parts.push(`--- stdout ---\n${rawTail(out)}`);
  const err = (ctx?.stderr ?? "").trim();
  if (err.length > 0) parts.push(`--- stderr ---\n${rawTail(err)}`);
  return parts.join("\n");
}

// Parse `claude --output-format json` stdout → the final assistant text.
// A non-success result, a malformed envelope, or a missing `result` is a
// hard failure the loop surfaces (it never silently returns empty output).
//
// `detectRateLimit` (when supplied) runs against the parsed envelope FIRST, and
// AGAIN over the raw stdout when the output is not JSON at all: a rate-limit /
// quota / overload condition becomes EXECUTOR_RATE_LIMITED (a wait) rather than
// the generic EXECUTOR_FAILED. This is defence-in-depth — the backend exits
// non-zero on `is_error`, so the capture seam usually catches the signal before
// the parser runs, but a clean-exit error envelope (or a non-JSON limit notice)
// is handled here too. On a genuine parse failure the raw stdout/stderr (+ exit
// code) ride into the thrown message so the failure is diagnosable.
export function parseClaudeResult(
  stdout: string,
  detectRateLimit?: RateLimitDetector,
  ctx?: ClaudeParseContext,
): string {
  const trimmed = stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON at all: it may still be a non-JSON rate-limit / overload notice
    // ("you've hit your weekly limit", "overloaded") — classify it as a wait
    // rather than a tight-retry failure before surfacing the raw output.
    if (detectRateLimit?.({ stdout: trimmed, ...(ctx?.stderr !== undefined ? { stderr: ctx.stderr } : {}) })) {
      throw new KernelError({
        code: "EXECUTOR_RATE_LIMITED",
        message: "claude -p hit a rate limit / quota",
        detail: { stdout_head: rawTail(trimmed) },
      });
    }
    throw new KernelError({
      code: "EXECUTOR_OUTPUT_INVALID",
      message: parseFailureMessage("claude -p did not return parseable JSON output", trimmed, ctx),
      detail: {
        stdout_head: rawTail(trimmed),
        ...(ctx?.stderr !== undefined ? { stderr_head: rawTail(ctx.stderr) } : {}),
        ...(ctx?.exitCode !== undefined ? { exit_code: ctx.exitCode } : {}),
      },
    });
  }
  const obj = parsed as { is_error?: unknown; subtype?: unknown; result?: unknown };
  if (detectRateLimit?.({ envelope: obj as Record<string, unknown> })) {
    throw new KernelError({
      code: "EXECUTOR_RATE_LIMITED",
      message: "claude -p hit a rate limit / quota",
      detail: {
        result_head: typeof obj.result === "string" ? obj.result.slice(0, 500) : undefined,
      },
    });
  }
  if (obj.is_error === true) {
    const resultText = typeof obj.result === "string" ? obj.result : "";
    const subtype = typeof obj.subtype === "string" ? obj.subtype : undefined;
    // A clean-exit error envelope carrying a PERMANENT provider error (bad
    // model id, auth/billing) gets its own code so the supervisor parks rather
    // than re-running an identical, identically-failing spawn five times.
    const permanent = classifyPermanentProviderError(`${subtype ?? ""}\n${resultText}`);
    if (permanent !== null) {
      throw new KernelError({
        code: PERMANENT_PROVIDER_ERROR_CODE[permanent],
        message: `claude -p rejected the request (${permanent}): ${resultText.slice(0, 300)}`,
        detail: { subtype, result_head: resultText.slice(0, 500) },
      });
    }
    throw new KernelError({
      code: "EXECUTOR_FAILED",
      message: `claude -p reported an error (subtype: ${String(obj.subtype)})`,
      detail: {
        subtype,
        result_head: resultText.length > 0 ? resultText.slice(0, 500) : undefined,
      },
    });
  }
  if (typeof obj.result !== "string") {
    throw new KernelError({
      code: "EXECUTOR_OUTPUT_INVALID",
      message: "claude -p JSON result is missing a string 'result' field",
      detail: {},
    });
  }
  return obj.result;
}

function finiteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// Extract per-spawn usage from a `claude -p --output-format json` envelope:
// token counts (mapped to the kernel's neutral in/out/cached shape) plus the
// backend-computed `total_cost_usd` and turn/duration figures. Returns
// undefined when the envelope carries no usage (so nothing is invented).
// Never throws — usage is best-effort accounting, never a failure path.
export function parseClaudeUsage(stdout: string): SpawnUsage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  const usage: SpawnUsage = {};

  const u = obj["usage"];
  if (typeof u === "object" && u !== null) {
    const uo = u as Record<string, unknown>;
    const inTok = finiteNumber(uo["input_tokens"]);
    const outTok = finiteNumber(uo["output_tokens"]);
    const cached = finiteNumber(uo["cache_read_input_tokens"]);
    if (inTok !== undefined || outTok !== undefined || cached !== undefined) {
      usage.tokens = {
        in: inTok ?? 0,
        out: outTok ?? 0,
        ...(cached !== undefined ? { cached } : {}),
      };
    }
  }
  const cost = finiteNumber(obj["total_cost_usd"]);
  if (cost !== undefined) usage.cost_usd = cost;
  const turns = finiteNumber(obj["num_turns"]);
  if (turns !== undefined) usage.num_turns = turns;
  const dur = finiteNumber(obj["duration_ms"]);
  if (dur !== undefined) usage.duration_ms = dur;

  return Object.keys(usage).length > 0 ? usage : undefined;
}

// Per-spawn capture knobs the backend forwards to the shared capture seam.
interface SpawnClaudeOptions {
  session_timeout_ms?: number;
  idle_timeout_ms?: number;
  detectRateLimit: RateLimitDetector;
}

async function spawnClaude(
  bin: string,
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  capture: SpawnClaudeOptions,
): Promise<RunSpawnResult> {
  const { stdout, stderr, exitCode } = await spawnCapture({
    bin,
    args,
    cwd,
    label: "claude -p",
    notFoundMessage:
      `Claude Code CLI '${bin}' was not found; install Claude Code and ` +
      `sign in (run 'claude') to drive headless runs on your subscription`,
    detectRateLimit: capture.detectRateLimit,
    ...(capture.session_timeout_ms !== undefined ? { session_timeout_ms: capture.session_timeout_ms } : {}),
    ...(capture.idle_timeout_ms !== undefined ? { idle_timeout_ms: capture.idle_timeout_ms } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });
  const output = parseClaudeResult(stdout, capture.detectRateLimit, { stderr, exitCode });
  const usage = parseClaudeUsage(stdout);
  return usage !== undefined ? { output, usage } : { output };
}

export function createClaudeCodeExecutor(opts: ClaudeCodeExecutorOptions): Executor {
  const bin = opts.claude_bin ?? "claude";
  const permissionMode = opts.permission_mode ?? DEFAULT_PERMISSION_MODE;
  const detectRateLimit = opts.detectRateLimit ?? defaultRateLimitDetector;
  const runSpawn: RunSpawn =
    opts.runSpawn ??
    ((intent, worktreeDir, signal) =>
      spawnClaude(bin, buildClaudeArgs(intent, permissionMode, opts.max_turns), worktreeDir, signal, {
        detectRateLimit,
        ...(opts.session_timeout_ms !== undefined ? { session_timeout_ms: opts.session_timeout_ms } : {}),
        ...(opts.idle_timeout_ms !== undefined ? { idle_timeout_ms: opts.idle_timeout_ms } : {}),
      }));

  return createSandboxedExecutor({
    project_dir: opts.project_dir,
    runSpawn,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.onNotice !== undefined ? { onNotice: opts.onNotice } : {}),
    ...(opts.onUsage !== undefined ? { onUsage: opts.onUsage } : {}),
  });
}
