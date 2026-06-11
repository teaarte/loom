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
//      wall-time cap, and capture exit code + an output TAIL (the most recent
//      16 KB — where a compiler/test run leaves its errors).
//   4. Return the envelope as the spawn's text output: a JSON object
//      `{ checks: [{ name, status, exit_code?, output_tail?, command? }] }`.
//      The bundle reads it back into its own state; the kernel sees opaque text.
//
// It edits no files, so it reports no file delta — `agent_output` is the only
// channel it uses. POSIX shells only: a configured shell-string check runs via
// `/bin/sh -c`; on a non-POSIX host the operator must use the argv (package.json
// script) form. Ambient runtime — transport OUTSIDE the kernel's replay graph;
// duration / timeout bounding goes through the injected timer seam, never the
// wall clock directly.

import { spawn } from "node:child_process";

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
    const tail = outcome.timed_out
      ? tailCap(`${outcome.output_tail}\n[killed: exceeded ${timeoutMs}ms timeout]`)
      : outcome.output_tail;
    return {
      name: spec.name,
      status,
      command: display,
      exit_code: outcome.exit_code,
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
      const envelope: ChecksEnvelope = { checks };
      // The envelope rides as the spawn's text output: the bundle reads it back
      // via the kernel's structured-output merge. No file delta — checks edit
      // nothing.
      return { agent_output: JSON.stringify(envelope) };
    },
  };
}

// The real child-process runner. Captures combined stdout+stderr (tail-capped),
// returns the exit code for ANY exit, and kills the child on a per-command
// timeout via the injected timer seam (SIGTERM then SIGKILL after a grace).
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

      let buf = "";
      const append = (chunk: Buffer): void => {
        buf += chunk.toString("utf8");
        // Keep the buffer bounded as it grows — retain a generous head room over
        // the final cap so the tail is intact without holding an unbounded log.
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
        resolve({ exit_code: null, output_tail: tailCap(`${buf}\n[${note}]`), timed_out: timedOut });
      });

      child.on("close", (code) => {
        cleanup();
        resolve({ exit_code: code, output_tail: tailCap(buf), timed_out: timedOut });
      });
    });
}
