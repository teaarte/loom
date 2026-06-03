// The supervisor — a long-lived loop that wraps the headless `drive()` and
// carries one logical task to a terminal outcome while surviving the three
// things a one-shot `loom run` cannot: a human gate (park + wake), a
// transient failure (retry with backoff), and process death (recover from
// the store on restart).
//
// It is the SECOND consumer of `drive()` (after `loom run`), validating the
// C2 package seam. It adds NO daemon-specific kernel API — it is a transport
// + scheduler over `drive()` + existing primitives (`peekArchiveSlot`, the
// resume restart-head inside `drive()`, the kernel's `ZOMBIE_PENDING_MS`). It
// is bundle- and domain-BLIND: every decision is by COUNT, TIME, STATUS, or
// error CODE — never a bundle's meaning (the daemon-leak gate stays green).
//
// It holds NO state the store does not: a restart re-`peek`s the slot and
// re-`drive()`s (the C1 restart-head), so a kill mid-task is recovered from
// the store, never from supervisor memory. The advisory status file is the
// only thing it writes outside the store, and recovery never depends on it.

import { drive, readState, type DriveOutcome, type Executor, type SpawnUsage } from "@loomfsm/driver";
import {
  peekArchiveSlot,
  ZOMBIE_PENDING_MS,
  type GateRole,
  type PipelineState,
  type PolicyName,
  type Registry,
} from "@loomfsm/kernel";
import { createHash } from "node:crypto";

import { type Clock, systemClock } from "./clock.js";
import { type DaemonLogger, nullLogger } from "./logger.js";
import {
  backoffDelayMs,
  DEFAULT_RETRY_POLICY,
  defaultClassifier,
  type ErrorClassifier,
  type RetryPolicy,
} from "./retry.js";
import { sweepOrphanClone, sweepOrphanWorktree } from "./worktree-lifecycle.js";
import { commitToBranchMergeBack, type MergeBackResult } from "./worktree-lifecycle.js";
import type { DaemonPhase } from "./process-control.js";
import { waitForWake, type WakeOptions } from "./wake.js";

type DriveCompleteOutcome = Extract<DriveOutcome, { kind: "complete" }>;

// Wait this long on a recognised rate-limit before re-driving — long enough to
// outlast a subscription usage window without escalating, short enough to
// re-probe periodically. A fixed wait (the backend's envelope carries no
// machine-readable reset) the deployment can override.
export const DEFAULT_RATE_LIMIT_WAIT_MS = 3_600_000; // 1h

// After this many consecutive error escalations on the SAME in-progress slot,
// `superviseWatch` stops re-driving it (parks) instead of looping — a wedged
// task must not be hammered. Generic by COUNT.
export const DEFAULT_WATCH_ERROR_PARK_AFTER = 3;

// The minimal advisory-status surface the supervisor pokes (a `DaemonHandle`
// satisfies it). Optional — embedders that don't run the process-control
// file omit it.
export interface StatusUpdater {
  update(phase: DaemonPhase, fields?: { task_id?: string | null; detail?: string }): void;
}

export interface ExecutorBuildContext {
  // Wire the executor's non-fatal notices (the degraded/no-isolation
  // warning) into the supervisor's audit sink.
  onNotice: (message: string) => void;
  // Wire per-spawn usage (tokens / cost the backend reports) into the
  // supervisor's audit sink — observable now; not persisted by the loop.
  onUsage: (usage: SpawnUsage) => void;
  // The attempt's abort signal (graceful shutdown ∪ optional per-drive
  // deadline) — a sandboxed `claude -p` executor passes it to the child so a
  // hung spawn is actually interrupted.
  signal: AbortSignal;
}

export interface SuperviseOptions {
  // Build the executor for ONE drive attempt (rebuilt per attempt so the
  // attempt's signal reaches the backend; the deterministic worktree path
  // makes re-provisioning idempotent).
  buildExecutor: (ctx: ExecutorBuildContext) => Executor;
  resolveRegistry: (projectDir: string) => Promise<Registry> | Registry;

  // Present → start a fresh task; absent → attach to the project's active
  // task (the recovery / resume path).
  task?: string;
  policy_preset?: string;
  gate_policies?: Partial<Record<GateRole, PolicyName>>;
  complexity_hint?: "simple" | "medium" | "complex";

  // Generic, injectable knobs — all by count/time/code, never by domain.
  retry_policy?: RetryPolicy;
  classifyError?: ErrorClassifier;
  wake?: WakeOptions;
  // Abort a single drive that runs longer than this (a hung spawn); treated
  // as a transient failure and re-driven. Omitted → no per-drive deadline.
  drive_deadline_ms?: number;
  // Wait this long on a recognised rate-limit before re-driving — does NOT
  // count against `retry_policy.max_attempts`. Default 1h.
  rate_limit_wait_ms?: number;
  // Idle-poll cadence for `superviseWatch` between tasks. Default 5s.
  watch_idle_ms?: number;
  // After this many consecutive error escalations on one in-progress slot,
  // `superviseWatch` parks it (stops re-driving) instead of tight-looping.
  // Default 3.
  watch_error_park_after?: number;

  // Integrate the worktree on `complete`. Default = commit-to-branch
  // `loom/<task>` + GC (`commitToBranchMergeBack`).
  mergeBack?: (
    projectDir: string,
    outcome: DriveCompleteOutcome,
  ) => MergeBackResult | Promise<MergeBackResult>;
  // Crash-safe create idempotency: a deterministic uuid from the task so a
  // re-create after a crash-during-create dedups. Default = sha256(task).
  idempotencyUuidFor?: (task: string) => string;

  logger?: DaemonLogger;
  clock?: Clock;
  // Graceful-shutdown signal (SIGTERM/SIGINT, wired by the CLI).
  signal?: AbortSignal;
  handle?: StatusUpdater;
}

export type SupervisionResult =
  | {
      kind: "complete";
      task_id: string | null;
      verdict: string;
      summary: string;
      merge_back: MergeBackResult;
      attempts: number;
    }
  | { kind: "error"; code: string; message: string; attempts: number }
  | { kind: "aborted"; reason: string }
  | { kind: "noop"; reason: string };

// Drive ONE logical task to terminal, surviving parks/retries/restarts.
export async function superviseToTerminal(
  projectDir: string,
  opts: SuperviseOptions,
): Promise<SupervisionResult> {
  const clock = opts.clock ?? systemClock;
  const logger = opts.logger ?? nullLogger;
  const policy = opts.retry_policy ?? DEFAULT_RETRY_POLICY;
  const classify = opts.classifyError ?? defaultClassifier;
  const rateLimitWaitMs = opts.rate_limit_wait_ms ?? DEFAULT_RATE_LIMIT_WAIT_MS;
  const mergeBack =
    opts.mergeBack ?? ((dir, o): MergeBackResult => commitToBranchMergeBack(dir, o.task_id));
  const uuidFor = opts.idempotencyUuidFor ?? deterministicUuid;

  // ----- recovery-on-start: inspect the slot ------------------------------
  const slot = await peekArchiveSlot(projectDir);
  const slotInProgress = slot !== null && slot.status === "in_progress";
  if (slotInProgress) {
    const state = await readState(projectDir);
    const stale = detectStaleness(state, clock);
    logger.info("recover-on-start", {
      task_id: slot.task_id,
      stalled: stale.stalled,
      oldest_age_ms: stale.oldest_age_ms,
    });
  } else if (opts.task === undefined) {
    logger.info("nothing-to-supervise", { slot_status: slot?.status ?? null });
    return { kind: "noop", reason: slot === null ? "no-active-task" : `slot-${slot.status ?? "unknown"}` };
  }

  // ----- drive loop -------------------------------------------------------
  // `seedTask` seeds only the FIRST drive; once a task exists in the slot,
  // every later drive attaches (no re-create, no accidental rotation).
  let seedTask = slotInProgress ? undefined : opts.task;
  let transientAttempts = 0;

  for (;;) {
    if (opts.signal?.aborted) return { kind: "aborted", reason: "shutdown" };

    opts.handle?.update("driving", { task_id: slot?.task_id ?? null });
    const driveUuid = seedTask !== undefined ? uuidFor(seedTask) : undefined;
    const { outcome, timedOut } = await driveWithDeadline(
      projectDir,
      { task: seedTask, uuid: driveUuid },
      opts,
      logger,
    );
    seedTask = undefined; // never re-seed after the first attempt

    // A shutdown abort surfaces as a DRIVE_ABORTED outcome — intercept it
    // before classifying, so it never looks like a retryable failure.
    if (opts.signal?.aborted) return { kind: "aborted", reason: "shutdown" };

    if (outcome.kind === "complete") {
      logger.info("complete", { task_id: outcome.task_id, verdict: outcome.verdict });
      const mb = await mergeBack(projectDir, outcome);
      logger.info("merge-back", {
        merged: mb.merged,
        ...(mb.branch !== undefined ? { branch: mb.branch } : {}),
        ...(mb.files_changed !== undefined ? { files: mb.files_changed.length } : {}),
        ...(mb.reason !== undefined ? { reason: mb.reason } : {}),
      });
      opts.handle?.update("stopping", { task_id: outcome.task_id, detail: outcome.verdict });
      return {
        kind: "complete",
        task_id: outcome.task_id,
        verdict: outcome.verdict,
        summary: outcome.summary,
        merge_back: mb,
        attempts: transientAttempts,
      };
    }

    if (outcome.kind === "paused" && !timedOut) {
      logger.info("parked", {
        gate: outcome.gate,
        gate_event_id: outcome.gate_event_id,
        message: outcome.message,
      });
      opts.handle?.update("parked", { detail: outcome.gate });
      const woke = await waitForWake(projectDir, outcome.gate_event_id, {
        ...(opts.wake ?? {}),
        clock,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
      if (woke === "aborted") return { kind: "aborted", reason: "shutdown" };
      logger.info("woken", { gate: outcome.gate });
      transientAttempts = 0; // a fresh leg after the human decision
      continue;
    }

    // Everything else is an error (a real `error` outcome, or a deadline
    // timeout normalized to a transient one).
    const code = timedOut ? "DRIVE_TIMEOUT" : outcome.kind === "error" ? outcome.code : "UNEXPECTED";
    const message = timedOut
      ? `drive exceeded its ${opts.drive_deadline_ms}ms deadline`
      : outcome.kind === "error"
        ? outcome.message
        : `unexpected outcome ${outcome.kind}`;
    const disposition = timedOut ? "transient" : classify(code);

    // A recognised rate-limit clears only with time — wait the configured
    // duration and re-drive, WITHOUT spending the transient-retry budget on a
    // wall that retrying cannot move. Abort during the wait → aborted.
    if (disposition === "rate-limited") {
      logger.warn("rate-limit-wait", { code, message, wait_ms: rateLimitWaitMs });
      opts.handle?.update("backing-off", { detail: "rate-limited" });
      await clock.sleep(rateLimitWaitMs, opts.signal);
      if (opts.signal?.aborted) return { kind: "aborted", reason: "shutdown" };
      continue;
    }

    if (disposition === "terminal") {
      logger.error("escalate", { code, message });
      opts.handle?.update("stopping", { detail: code });
      return { kind: "error", code, message, attempts: transientAttempts };
    }

    transientAttempts += 1;
    if (transientAttempts > policy.max_attempts) {
      logger.error("escalate-ceiling", { code, message, attempts: transientAttempts });
      opts.handle?.update("stopping", { detail: code });
      return { kind: "error", code, message, attempts: transientAttempts };
    }
    const delay = backoffDelayMs(policy, transientAttempts);
    logger.warn("retry", { code, message, attempt: transientAttempts, delay_ms: delay });
    opts.handle?.update("backing-off", { detail: code });
    await clock.sleep(delay, opts.signal);
    if (opts.signal?.aborted) return { kind: "aborted", reason: "shutdown" };
  }
}

// `--watch`: supervise the project's single slot continuously. Drives the
// active task (or a seed task on first iteration) to terminal, then idle-polls
// for the NEXT task to appear in the slot. This idle hook is the seam a future
// intake (Jira monitor / Telegram bot / HTTP `submit`) plugs into — it writes
// a task into the store, the watcher picks it up. Runs until the signal aborts.
export async function superviseWatch(projectDir: string, opts: SuperviseOptions): Promise<void> {
  const clock = opts.clock ?? systemClock;
  const logger = opts.logger ?? nullLogger;
  const policy = opts.retry_policy ?? DEFAULT_RETRY_POLICY;
  const idlePoll = opts.watch_idle_ms ?? 5_000;
  const parkAfter = opts.watch_error_park_after ?? DEFAULT_WATCH_ERROR_PARK_AFTER;

  // Startup GC: prune stale worktree admin + drop an orphaned isolation dir
  // (worktree OR container clone) when no task is live to own it. Mode-blind —
  // each sweep is a no-op if its dir is absent.
  const slot0 = await peekArchiveSlot(projectDir);
  const slotInProgress0 = slot0?.status === "in_progress";
  sweepOrphanWorktree(projectDir, { slotInProgress: slotInProgress0 });
  sweepOrphanClone(projectDir, { slotInProgress: slotInProgress0 });

  let seedTask = opts.task;
  // Cool-down / park bookkeeping for an escalating slot: when a drive escalates
  // (`{kind:"error"}`) the slot stays `in_progress`, so without this the loop
  // would re-drive immediately — a tight loop hammering the backend. We
  // exponentially cool down after each error and, after `parkAfter` consecutive
  // errors on the SAME task, PARK the slot: stop re-driving and idle-poll until
  // it leaves `in_progress` (an operator resets/abandons it, or a new task
  // lands). Generic by COUNT + TIME; keyed by task_id so a new task resets it.
  let consecutiveErrors = 0;
  let parkedTaskId: string | null = null;

  for (;;) {
    if (opts.signal?.aborted) {
      logger.info("watch-stop");
      return;
    }
    const slot = await peekArchiveSlot(projectDir);
    const inProgress = slot !== null && slot.status === "in_progress";

    if (inProgress) {
      const taskId = slot.task_id ?? null;
      // A different task than the one we parked → the wedge is gone; reset.
      if (parkedTaskId !== null && parkedTaskId !== taskId) {
        parkedTaskId = null;
        consecutiveErrors = 0;
      }
      // Parked on this exact wedged slot: do NOT re-drive — idle-poll until it
      // leaves `in_progress`.
      if (parkedTaskId === taskId) {
        opts.handle?.update("idle", { detail: "parked-on-error" });
        await clock.sleep(idlePoll, opts.signal);
        continue;
      }
      const result = await superviseToTerminal(projectDir, { ...opts, task: undefined });
      if (result.kind === "error") {
        consecutiveErrors += 1;
        if (consecutiveErrors >= parkAfter) {
          parkedTaskId = taskId;
          logger.error("watch-park", {
            code: result.code,
            message: result.message,
            after: consecutiveErrors,
          });
          opts.handle?.update("idle", { detail: "parked-on-error" });
          await clock.sleep(idlePoll, opts.signal);
          continue;
        }
        const cool = backoffDelayMs(policy, consecutiveErrors);
        logger.warn("watch-cool-down", {
          code: result.code,
          attempt: consecutiveErrors,
          delay_ms: cool,
        });
        opts.handle?.update("backing-off", { detail: "watch-error" });
        await clock.sleep(cool, opts.signal);
      } else {
        consecutiveErrors = 0;
      }
      continue;
    }

    // Not in_progress → any earlier wedge is gone; clear the park.
    parkedTaskId = null;
    consecutiveErrors = 0;
    if (seedTask !== undefined) {
      await superviseToTerminal(projectDir, { ...opts, task: seedTask });
      seedTask = undefined;
      continue;
    }
    opts.handle?.update("idle");
    logger.info("idle", { poll_ms: idlePoll });
    await clock.sleep(idlePoll, opts.signal);
  }
}

// Pending-row ageing — the staleness signal (generic, by TIME). Reuses the
// kernel's `ZOMBIE_PENDING_MS` threshold rather than inventing a value, the
// same one `loom status` flags on.
export function detectStaleness(
  state: PipelineState,
  clock: Clock,
): { stalled: boolean; oldest_age_ms: number } {
  let oldest = 0;
  for (const row of state.pending_agents) {
    const age = Math.max(0, clock.now() - Date.parse(row.started_at));
    if (age > oldest) oldest = age;
  }
  return { stalled: oldest >= ZOMBIE_PENDING_MS, oldest_age_ms: oldest };
}

// ----- internals ---------------------------------------------------------

// Run one `drive()` with a per-attempt abort signal (shutdown ∪ optional
// deadline) and a freshly built executor whose notices feed the logger.
async function driveWithDeadline(
  projectDir: string,
  attempt: { task?: string; uuid?: string },
  opts: SuperviseOptions,
  logger: DaemonLogger,
): Promise<{ outcome: DriveOutcome; timedOut: boolean }> {
  const controller = new AbortController();
  const onShutdown = (): void => controller.abort();
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onShutdown, { once: true });
  }

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.drive_deadline_ms !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.drive_deadline_ms);
  }

  const executor = opts.buildExecutor({
    onNotice: (message) => logger.warn("executor-notice", { message }),
    onUsage: (usage) =>
      logger.info("spawn-usage", {
        ...(usage.cost_usd !== undefined ? { cost_usd: usage.cost_usd } : {}),
        ...(usage.tokens !== undefined
          ? { tokens_in: usage.tokens.in, tokens_out: usage.tokens.out, tokens_cached: usage.tokens.cached }
          : {}),
        ...(usage.num_turns !== undefined ? { num_turns: usage.num_turns } : {}),
      }),
    signal: controller.signal,
  });

  try {
    const outcome = await drive(projectDir, {
      executor,
      resolveRegistry: opts.resolveRegistry,
      ...(attempt.task !== undefined ? { task: attempt.task } : {}),
      ...(attempt.uuid !== undefined ? { client_idempotency_uuid: attempt.uuid } : {}),
      ...(opts.policy_preset !== undefined ? { policy_preset: opts.policy_preset } : {}),
      ...(opts.gate_policies !== undefined ? { gate_policies: opts.gate_policies } : {}),
      ...(opts.complexity_hint !== undefined ? { complexity_hint: opts.complexity_hint } : {}),
      signal: controller.signal,
    });
    return { outcome, timedOut };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onShutdown);
  }
}

function deterministicUuid(task: string): string {
  return `cidem-${createHash("sha256").update(task).digest("hex").slice(0, 24)}`;
}
