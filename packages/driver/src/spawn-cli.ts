// Shared child-process capture for CLI backends.
//
// Both headless backends shell out to an external CLI and read its stdout: the
// `claude -p` backend spawns `claude` in the worktree, and the container
// backend spawns `docker run … claude -p` (the same JSON envelope, wrapped).
// They share identical machinery — capture stdout/stderr, map ENOENT to a
// clean "binary not found" refusal, fail loudly on a non-zero exit — so it
// lives here once. The caller parses the captured stdout (both backends parse
// the same `claude -p` JSON via `parseClaudeResult` / `parseClaudeUsage`).
//
// This one seam also owns the operational timeouts both backends need
// identically — a wall-time session cap and an output-silence (idle) cap — so a
// wedged spawn is killed where the child actually lives, rather than threading
// a "last output at" signal up into the loop. And it is where a sustained
// rate-limit is recognised: a non-zero exit still carries the backend's JSON
// envelope on stdout, so the injected detector reads the status here and the
// failure is classified `EXECUTOR_RATE_LIMITED` (a wait, not an escalation)
// rather than a generic `EXECUTOR_FAILED`.
//
// No npm dep: this is `node:child_process`, the same posture as shelling to
// `claude`.

import { spawn } from "node:child_process";

import { KernelError } from "@loomfsm/kernel";

import type { RateLimitDetector } from "./rate-limit.js";

// Grace between SIGTERM and SIGKILL when a timeout kills the child: let the
// child (and, for the container backend, the `docker run` client that forwards
// SIGTERM to PID1 so `--rm` can clean up) tear down cleanly before forcing it.
const KILL_GRACE_MS = 5_000;

// How much of each captured stream is folded into a failure (truncated). A
// failed/hung spawn is only diagnosable if its raw output rides into the
// surfaced error — `drive()` forwards the thrown error's MESSAGE, not its
// structured detail, so the raw tail has to live in the message to reach the
// daemon log without spelunking the backend's own session transcript.
const RAW_HEAD = 1_500;
const RAW_TAIL = 1_500;

// Keep the head AND tail of a long stream (the start of a broken JSON envelope
// and the final error/result, which sit at opposite ends), bounded so a log
// line never balloons. A short stream passes through whole.
export function truncateStream(s: string, head = RAW_HEAD, tail = RAW_TAIL): string {
  const t = s.trim();
  const max = head + tail;
  if (t.length <= max) return t;
  return `${t.slice(0, head)}\n…[${t.length - max} chars omitted]…\n${t.slice(t.length - tail)}`;
}

// A compact "what did it actually print?" annex for a failure message — only
// the streams that carried anything, each truncated.
function rawAnnex(stdout: string, stderr: string): string {
  const parts: string[] = [];
  const out = stdout.trim();
  const err = stderr.trim();
  if (out.length > 0) parts.push(`--- stdout ---\n${truncateStream(out)}`);
  if (err.length > 0) parts.push(`--- stderr ---\n${truncateStream(err)}`);
  return parts.length > 0 ? `\n${parts.join("\n")}` : "";
}

export interface SpawnCaptureOptions {
  bin: string;
  args: string[];
  // Used in the non-zero-exit failure message (e.g. "claude -p", "docker run").
  label: string;
  // The ENOENT refusal message — backend-specific install guidance.
  notFoundMessage: string;
  cwd?: string;
  // Child environment (the container backend passes the OAuth token here so it
  // is forwarded by `-e NAME` and never lands on the command line).
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  // Kill the child if the whole run exceeds this wall-time → reject
  // EXECUTOR_TIMEOUT (transient). Omitted → no session cap.
  session_timeout_ms?: number;
  // Kill the child if it emits NO stdout/stderr for this long → reject
  // EXECUTOR_IDLE_TIMEOUT (transient). The timer resets on every chunk.
  // Omitted → no idle cap.
  idle_timeout_ms?: number;
  // Recognise a sustained rate-limit / quota condition from the finished run
  // (envelope on stdout, stderr, exit code) → reject EXECUTOR_RATE_LIMITED
  // instead of EXECUTOR_FAILED. Injectable; omitted → no rate-limit class.
  detectRateLimit?: RateLimitDetector;
}

// A clean (exit 0) capture: stdout for the caller's parser, plus the stderr and
// exit code so a downstream parse FAILURE can fold the raw output into its error
// (the caller only sees these on success; a non-zero exit is rejected here).
export interface SpawnCaptureResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

// Spawn the CLI and resolve with its captured streams on a clean (exit 0) run.
// Rejects with EXECUTOR_NOT_FOUND on ENOENT, EXECUTOR_TIMEOUT /
// EXECUTOR_IDLE_TIMEOUT on a timeout kill, EXECUTOR_RATE_LIMITED on a recognised
// rate-limit, and EXECUTOR_FAILED on any other non-zero exit (its message
// carries the truncated raw stdout/stderr so the failure is diagnosable) — the
// loop's executor-retry / rate-limit-wait / error-surfacing handles each.
export function spawnCapture(opts: SpawnCaptureOptions): Promise<SpawnCaptureResult> {
  return new Promise<SpawnCaptureResult>((resolveRun, reject) => {
    const child = spawn(opts.bin, opts.args, {
      // No stdin: this is a non-interactive capture seam — the backend's input
      // rides in argv, never on stdin. `ignore` gives the child immediate EOF on
      // fd 0 (stdout/stderr stay piped for capture). Leaving stdin an open,
      // never-written pipe (node's default) hangs any backend that READS stdin
      // before acting — opencode's `run` does exactly that and wedged at startup;
      // claude -p / aider / docker never read it, so this is a no-op for them.
      stdio: ["ignore", "pipe", "pipe"],
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });

    let stdout = "";
    let stderr = "";
    // Set when a timeout fires: the child is killed and we wait for `close` to
    // settle with this code, so the child is actually torn down before we
    // reject (no orphaned process / container).
    let timedOut: { code: string; message: string } | null = null;
    let sessionTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = (): void => {
      if (sessionTimer !== undefined) clearTimeout(sessionTimer);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (sigkillTimer !== undefined) clearTimeout(sigkillTimer);
    };

    const fireTimeout = (code: string, message: string): void => {
      if (timedOut !== null) return; // first timeout wins
      timedOut = { code, message };
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (sessionTimer !== undefined) clearTimeout(sessionTimer);
      // Graceful first; the `docker run` client forwards SIGTERM to PID1 and
      // `--rm` cleans up, and a worktree `claude` exits on it. Force-kill only
      // if it ignores the grace window.
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone — `close` will settle the rejection
      }
      sigkillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, KILL_GRACE_MS);
    };

    const armIdle = (): void => {
      if (opts.idle_timeout_ms === undefined) return;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () =>
          fireTimeout(
            "EXECUTOR_IDLE_TIMEOUT",
            `${opts.label} produced no output for ${opts.idle_timeout_ms}ms`,
          ),
        opts.idle_timeout_ms,
      );
    };

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      armIdle();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
      armIdle();
    });

    if (opts.session_timeout_ms !== undefined) {
      sessionTimer = setTimeout(
        () =>
          fireTimeout(
            "EXECUTOR_TIMEOUT",
            `${opts.label} exceeded its ${opts.session_timeout_ms}ms session timeout`,
          ),
        opts.session_timeout_ms,
      );
    }
    armIdle();

    child.on("error", (err) => {
      clearTimers();
      const code = (err as { code?: unknown }).code;
      if (code === "ENOENT") {
        reject(
          new KernelError({
            code: "EXECUTOR_NOT_FOUND",
            message: opts.notFoundMessage,
            detail: { bin: opts.bin },
          }),
        );
        return;
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    });

    child.on("close", (exitCode) => {
      clearTimers();
      // A timeout kill: surface the timeout class, not the incidental non-zero
      // exit the kill produced. Carry the raw tails so a wedged spawn's partial
      // output is inspectable.
      if (timedOut !== null) {
        reject(
          new KernelError({
            code: timedOut.code,
            message: `${timedOut.message}${rawAnnex(stdout, stderr)}`,
            detail: {
              exit_code: exitCode,
              stdout_head: truncateStream(stdout),
              stderr_head: truncateStream(stderr),
            },
          }),
        );
        return;
      }
      if (exitCode !== 0) {
        // A non-zero exit still carries the JSON envelope on stdout — check for
        // a sustained rate-limit before falling back to the generic failure.
        if (opts.detectRateLimit?.({ stdout, stderr, exitCode })) {
          reject(
            new KernelError({
              code: "EXECUTOR_RATE_LIMITED",
              message: `${opts.label} hit a rate limit / quota`,
              detail: { exit_code: exitCode, stderr_head: truncateStream(stderr) },
            }),
          );
          return;
        }
        // Fold the raw stdout/stderr (truncated) into the MESSAGE: `drive()`
        // forwards the message but drops the detail, so this is the only path by
        // which "why did this spawn fail?" reaches the daemon log.
        reject(
          new KernelError({
            code: "EXECUTOR_FAILED",
            message: `${opts.label} exited with code ${exitCode}${rawAnnex(stdout, stderr)}`,
            detail: {
              exit_code: exitCode,
              stdout_head: truncateStream(stdout),
              stderr_head: truncateStream(stderr),
            },
          }),
        );
        return;
      }
      resolveRun({ stdout, stderr, exitCode });
    });
  });
}
