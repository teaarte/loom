// Deterministic checks executor — runs the project's typecheck / lint / test
// commands inside the task's isolated working copy and reports a structured
// envelope, never calling a model.
//
// It is a concrete `Executor` behind the SAME seam every model backend uses, so
// the driver loop and the kernel learn nothing new: the loop calls
// `execute(intent)` and reads the result exactly as for a model spawn. A spawn
// is routed HERE (instead of a backend chain) by the dispatch shell when the
// transport's capability resolver marks the spawn's agent as a checks runner —
// selection is by a generic, bundle-declared capability, not by agent name.
//
// What it does per `execute`:
//   1. Provision (or REUSE) the task's worktree — the same deterministic copy a
//      prior file-editing spawn ran in, so the checks see that spawn's edits.
//   2. Resolve the command list (typecheck / lint / test) the transport injects
//      from the project's config + package.json detection.
//   3. Run each command in the worktree with the spawn's env, a per-command
//      wall-time cap, and capture exit code + an output HEAD (the first 32 KB,
//      where a compiler prints its first error) AND an output TAIL (the most
//      recent 16 KB — the run's summary).
//   4. Return the envelope as the spawn's text output: a JSON object
//      `{ checks: [{ name, status, exit_code?, output_head?, output_tail?, command? }] }`.
//      The bundle reads it back into its own state; the kernel sees opaque text.
//   5. Write the FULL-fidelity failure report into the worktree at
//      `.loom/work/check-failures.txt` so the next file-editing spawn (which
//      reuses this worktree) reads the complete compiler output the bounded
//      finding only points at. Overwritten each round, removed when all pass.
//
// It edits no files, so it reports no file delta — `agent_output` is the only
// channel it uses. POSIX shells only: a configured shell-string check runs via
// `/bin/sh -c`; on a non-POSIX host the operator must use the argv (package.json
// script) form. Ambient runtime — transport OUTSIDE the kernel's replay graph;
// duration / timeout bounding goes through the injected timer seam, never the
// wall clock directly.

import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { KernelError, type ProviderShuttleIntent } from "@loomfsm/kernel";

import type { Executor, ExecutorResult } from "./drive.js";
import { provisionWorktree, type WorktreeProvision } from "./worktree.js";

// Default per-command wall-time cap (10 minutes). A check that exceeds it is
// killed and reported as a failure with a timeout note — a wedged build must
// not hang the whole drive.
const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;

// How much of each command's combined stdout+stderr is retained — the TAIL,
// where a failing typecheck / test run prints its errors + summary. Bounds the
// envelope so a noisy build cannot balloon the delivered output.
const OUTPUT_TAIL_BYTES = 16 * 1024;

// How much of the HEAD is retained — where a compiler prints its FIRST error
// (and a test runner its first failure). The blocking finding is built from the
// head, and the failure file leads with it, so the implementer reads the first
// errors first.
const OUTPUT_HEAD_BYTES = 32 * 1024;

// Per-check bounds in the failure file: the head (first errors) plus a tail
// (final summary), with an omission marker between when the run produced more.
const FILE_TAIL_BYTES = 8 * 1024;

// The worktree-relative path of the full-fidelity failure report the next
// file-editing spawn reads. Lives under loom's own `.loom/work/` scratch area,
// beside the diff the reviewers read.
const CHECK_FAILURES_REL = join(".loom", "work", "check-failures.txt");

// Grace between SIGTERM and SIGKILL when a timeout kills the child — let it tear
// down cleanly before forcing it.
const KILL_GRACE_MS = 5_000;

// The three checks, in stable order. Mirrors `@loomfsm/config`'s `CheckName`
// without importing it (the driver stays config-agnostic — the transport bridges
// the resolved command list into this shape).
export type CheckName = "typecheck" | "lint" | "test";

// How one check should run — the structural mirror of config's
// `ResolvedCheckRun`, redeclared here so the driver depends on no higher layer.
export type CheckRun =
  | { kind: "shell"; command: string }
  | { kind: "argv"; argv: string[]; display: string }
  | { kind: "skip"; reason: string };

export interface CheckSpec {
  name: CheckName;
  run: CheckRun;
}

// One check's outcome in the delivered envelope.
//   - "ok":      command exited 0.
//   - "fail":    non-zero exit (or a timeout / spawn failure).
//   - "skipped": nothing configured and nothing detected — recorded, not failed.
export type CheckStatus = "ok" | "fail" | "skipped";

export interface CheckResult {
  name: CheckName;
  status: CheckStatus;
  // The command line that ran (display form) — absent for a skipped check.
  command?: string;
  // Present for ok/fail (null when the child was killed before exiting).
  exit_code?: number | null;
  // Head of the combined output — the FIRST bytes (capped to 32 KB), where a
  // compiler/test run prints its first error. The bundle builds the blocking
  // finding from this. Present for ok/fail when the run produced any output.
  output_head?: string;
  // Tail of the combined output — present for ok/fail, capped to 16 KB.
  output_tail?: string;
}

export interface ChecksEnvelope {
  checks: CheckResult[];
}

// What the default child-process runner is handed for one command. The shell vs
// argv distinction is already resolved into `bin` + `args` by `runOne` below.
export interface CheckCommandSpec {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface CheckCommandOutcome {
  exit_code: number | null;
  // Combined stdout+stderr, already tail-capped by the runner.
  output_tail: string;
  // The first bytes of the combined output (head-capped by the runner).
  // Optional so an injected test runner that only cares about the tail need not
  // supply it.
  output_head?: string;
  timed_out: boolean;
}

// The injectable child-process seam: run one command, resolve with its outcome
// for ANY exit code (a non-zero exit is a normal check failure, never a throw).
// Tests inject a fake runner so the executor's mapping logic is exercised
// without real subprocesses — the database is never faked, only the child.
export type CheckCommandRunner = (spec: CheckCommandSpec) => Promise<CheckCommandOutcome>;

export interface ChecksExecutorOptions {
  // The project root. The worktree is derived deterministically from it (the
  // same copy a file-editing spawn used), unless `provision` overrides it.
  project_dir: string;
  // Resolve the ordered command list for the project. Injected by the transport
  // (which owns the config + package.json detection); the executor stays
  // config-agnostic. Called per `execute` so a config edit between spawns is
  // honored.
  resolveCommands: () => CheckSpec[] | Promise<CheckSpec[]>;
  // The environment each check command runs with (PATH, package-manager home,
  // etc.). Defaults to the executor process env.
  env?: NodeJS.ProcessEnv;
  // Per-command wall-time cap. Default 10 minutes.
  command_timeout_ms?: number;
  // How the per-task working copy is provisioned/reused. Default = the shared
  // detached worktree (`provisionWorktree`), so the checks run over the SAME
  // tree the file-editing spawn just edited. A container deployment injects its
  // clone provisioner here.
  provision?: () => WorktreeProvision;
  // Injectable child-process runner (test seam). Default shells out for real.
  runCommand?: CheckCommandRunner;
  // Test seam for the per-command timeout, mirroring spawn-cli: a suite injects
  // a controllable timer so the kill-on-timeout path is asserted without racing
  // a real wall clock. Defaults to the global timers.
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  // Non-fatal notice sink (e.g. the degraded "no isolation" warning). Dropped
  // when omitted.
  onNotice?: (message: string) => void;
}

// Keep the LAST `max` bytes of a string (the tail). A shorter string passes
// through unchanged; a longer one is prefixed with an omission marker so a
// reader knows it was clipped.
export function tailCap(s: string, max = OUTPUT_TAIL_BYTES): string {
  if (s.length <= max) return s;
  const kept = s.slice(s.length - max);
  return `…[${s.length - max} earlier chars omitted]…\n${kept}`;
}

// Keep the FIRST `max` bytes of a string (the head). A shorter string passes
// through unchanged; a longer one is suffixed with an omission marker so a
// reader knows more followed.
export function headCap(s: string, max = OUTPUT_HEAD_BYTES): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[${s.length - max} later chars omitted]…`;
}

export function createChecksExecutor(opts: ChecksExecutorOptions): Executor {
  const runCommand = opts.runCommand ?? defaultRunCommand(opts);
  const timeoutMs = opts.command_timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const env = opts.env ?? process.env;

  // Provision once per executor instance and reuse — the worktree path is
  // deterministic, so this finds the copy a prior file-editing spawn left.
  let provisioned: WorktreeProvision | null = null;
  const doProvision = opts.provision ?? ((): WorktreeProvision => provisionWorktree(opts.project_dir));
  const provision = (): WorktreeProvision => {
    if (provisioned === null) {
      provisioned = doProvision();
      if (provisioned.notice !== undefined) opts.onNotice?.(provisioned.notice);
      if (!provisioned.isolated) {
        opts.onNotice?.(
          `checks running in ${opts.project_dir} without isolation (not a git work tree)`,
        );
      }
    }
    return provisioned;
  };

  const runOne = async (
    spec: CheckSpec,
    cwd: string,
    signal: AbortSignal | undefined,
  ): Promise<CheckResult> => {
    if (spec.run.kind === "skip") {
      return { name: spec.name, status: "skipped" };
    }
    const { bin, args, display } =
      spec.run.kind === "shell"
        ? // The command string is operator-owned config, run VERBATIM via the
          // user's shell — loom interpolates nothing into it. POSIX only.
          { bin: "/bin/sh", args: ["-c", spec.run.command], display: spec.run.command }
        : { bin: spec.run.argv[0] ?? "", args: spec.run.argv.slice(1), display: spec.run.display };

    const outcome = await runCommand({
      bin,
      args,
      cwd,
      env,
      timeoutMs,
      ...(signal !== undefined ? { signal } : {}),
    });
    const status: CheckStatus = !outcome.timed_out && outcome.exit_code === 0 ? "ok" : "fail";
    // A timeout note rides on BOTH bounds: the tail (its natural place) and the
    // head (so a SHORT run that timed out — whose head holds the whole output —
    // still surfaces the kill in the finding and the failure file).
    const note = outcome.timed_out ? `\n[killed: exceeded ${timeoutMs}ms timeout]` : "";
    const tail = note.length > 0 ? tailCap(`${outcome.output_tail}${note}`) : outcome.output_tail;
    const head = headCap(`${outcome.output_head ?? ""}${note}`);
    return {
      name: spec.name,
      status,
      command: display,
      exit_code: outcome.exit_code,
      ...(head.length > 0 ? { output_head: head } : {}),
      output_tail: tail,
    };
  };

  return {
    // Re-running checks is always safe — they read the worktree and mutate no
    // external state — so a resume re-shuttle replays them harmlessly.
    idempotent: true,
    async execute(_intent: ProviderShuttleIntent, signal?: AbortSignal): Promise<ExecutorResult> {
      const wt = provision();
      const specs = await opts.resolveCommands();
      const checks: CheckResult[] = [];
      // Run sequentially: the checks share one working copy and one CPU budget,
      // and a deterministic order keeps the envelope stable on replay.
      for (const spec of specs) {
        checks.push(await runOne(spec, wt.dir, signal));
      }
      // Drop the full-fidelity failure report into the worktree the next
      // file-editing spawn reuses (or clear a stale one on a clean round).
      writeCheckFailures(wt.dir, checks);
      const envelope: ChecksEnvelope = { checks };
      // The envelope rides as the spawn's text output: the bundle reads it back
      // via the kernel's structured-output merge. No file delta — checks edit
      // nothing.
      return { agent_output: JSON.stringify(envelope) };
    },
  };
}

// Compose one failed check's body for the failure file: the head (first errors,
// carrying its own omission marker when the run produced more) followed by the
// last bytes of the tail (the final summary). A short run's whole output already
// lives in the head, so the tail is appended ONLY when it carries bytes the head
// does not — keeping the file to roughly the head's 32 KB plus an 8 KB tail.
function composeFailureBody(head: string, tail: string): string {
  if (head.length === 0) return tail;
  const tailPiece = tail.length > FILE_TAIL_BYTES ? tail.slice(tail.length - FILE_TAIL_BYTES) : tail;
  if (tailPiece.length === 0 || head.includes(tailPiece)) return head;
  return `${head}\n${tailPiece}`;
}

// Write (or clear) the full-fidelity failure report in the task worktree so the
// NEXT file-editing spawn — which reuses this same copy — reads the complete
// compiler output the bounded blocking finding only points at. One section per
// FAILED check (name, command, exit code, head + tail); overwritten every round
// and REMOVED when nothing failed, so a stale failure never haunts a later green
// round. Best-effort: a write failure never fails the checks (the finding still
// carries the bounded head). The path rides on the injected `provision` seam, so
// a test directs it at a temp dir without a new file-system seam.
function writeCheckFailures(dir: string, checks: CheckResult[]): void {
  const path = join(dir, CHECK_FAILURES_REL);
  try {
    const failed = checks.filter((c) => c.status === "fail");
    if (failed.length === 0) {
      rmSync(path, { force: true });
      return;
    }
    const sections = failed.map((c) => {
      const exit = c.exit_code === null || c.exit_code === undefined ? "killed" : String(c.exit_code);
      const body = composeFailureBody(c.output_head ?? "", c.output_tail ?? "");
      return `=== ${c.name} — ${c.command ?? c.name} (exit ${exit}) ===\n${body}`;
    });
    mkdirSync(join(dir, ".loom", "work"), { recursive: true });
    writeFileSync(path, `${sections.join("\n\n")}\n`, "utf8");
  } catch {
    /* best-effort — the bundle's finding still carries the bounded head */
  }
}

// The real child-process runner. Captures combined stdout+stderr as a HEAD (the
// first 32 KB) AND a tail-capped tail, returns the exit code for ANY exit, and
// kills the child on a per-command timeout via the injected timer seam (SIGTERM
// then SIGKILL after a grace).
function defaultRunCommand(opts: ChecksExecutorOptions): CheckCommandRunner {
  const setT = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimer ?? ((h) => clearTimeout(h));
  return (spec: CheckCommandSpec): Promise<CheckCommandOutcome> =>
    new Promise<CheckCommandOutcome>((resolve, reject) => {
      let child;
      try {
        child = spawn(spec.bin, spec.args, {
          stdio: ["ignore", "pipe", "pipe"],
          cwd: spec.cwd,
          env: spec.env,
          ...(spec.signal !== undefined ? { signal: spec.signal } : {}),
        });
      } catch (e) {
        reject(
          new KernelError({
            code: "CHECKS_SPAWN_FAILED",
            message: `could not start check command '${spec.bin}': ${e instanceof Error ? e.message : String(e)}`,
            detail: { bin: spec.bin },
          }),
        );
        return;
      }

      let headBuf = "";
      let buf = "";
      const append = (chunk: Buffer): void => {
        const s = chunk.toString("utf8");
        // Retain the FIRST bytes (stop once the head cap is reached, overshooting
        // by at most one chunk — headCap clamps it) so the first errors survive
        // even when the rolling tail has scrolled past them.
        if (headBuf.length < OUTPUT_HEAD_BYTES) headBuf += s;
        buf += s;
        // Keep the tail buffer bounded as it grows — retain a generous head room
        // over the final cap so the tail is intact without holding an unbounded log.
        if (buf.length > OUTPUT_TAIL_BYTES * 2) buf = buf.slice(buf.length - OUTPUT_TAIL_BYTES * 2);
      };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);

      let timedOut = false;
      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
      const sessionTimer = setT(() => {
        timedOut = true;
        child.kill("SIGTERM");
        sigkillTimer = setT(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      }, spec.timeoutMs);

      const cleanup = (): void => {
        clearT(sessionTimer);
        if (sigkillTimer !== undefined) clearT(sigkillTimer);
      };

      // ENOENT (command not found) is reported as a FAILED check (exit null +
      // the error in the tail), not a thrown executor error — a missing tool is
      // the operator's to fix, surfaced like any other check failure.
      child.on("error", (err: NodeJS.ErrnoException) => {
        cleanup();
        const note = err.code === "ENOENT" ? `command not found: ${spec.bin}` : err.message;
        const combined = buf.length > 0 ? `${buf}\n[${note}]` : `[${note}]`;
        // The note rides in the head too (an ENOENT leaves no other output, so
        // the finding — built from the head — would otherwise be empty).
        resolve({
          exit_code: null,
          output_head: headBuf.length > 0 ? `${headBuf}\n[${note}]` : `[${note}]`,
          output_tail: tailCap(combined),
          timed_out: timedOut,
        });
      });

      child.on("close", (code) => {
        cleanup();
        resolve({ exit_code: code, output_head: headBuf, output_tail: tailCap(buf), timed_out: timedOut });
      });
    });
}
