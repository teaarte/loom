// pipeline_resume — read-only re-emit of the current paused directive.
//
// A model-driven relay (or, later, a headless runner) drives a task by
// looping: take the current directive, execute it, deliver the result,
// take the next. If the transport drops mid-flight — a laptop sleeps, a
// socket closes — that loop just stops. The kernel state is intact and
// atomic; what was missing was a first-class way to ask "what is this
// task waiting on right now?" and get the SAME directive back so the loop
// can re-attach. That is all this tool does.
//
// It adds NO daemon-specific kernel API: it is a transport-neutral re-emit
// over the existing directive contract, so a future headless driver calls
// exactly this primitive to re-attach. Composition:
//   1. project-dir allowlist (refusal → error envelope, never a throw)
//   2. peek the slot — never opens/creates a store on a fresh project
//   3. branch by pause form:
//      - no slot                  → typed NO_ACTIVE_TASK envelope
//      - terminal (completed /     → a `complete` envelope so the host
//        abandoned)                  learns the task is already done
//      - pending_agents present   → re-shuttle the pending rows via
//        buildRetryFailedDirective, REUSING each agent_run_id (no fresh
//        begin_spawn → the spawn duplicate-window guard is never
//        consulted). The host re-delivers the same agent_run_id and the
//        idempotency ledger dedups the repeat. The re-shuttled prompt is a
//        stub — the host fetches the real prompt via
//        pipeline_get_spawn_prompt per agent_run_id, exactly as it does
//        for a by-reference fanout or a recovery retry-failed.
//      - pending_user_answer       → re-derive the ask-user directive from
//        present                     the registry's gate stage (its pure
//        message()/valid_answers() over the narrowed state), carrying the
//        PERSISTED gate_event_id so the eventual answer still binds to the
//        gate the kernel actually asked.
//      - otherwise                 → a tick that never produced its first
//                                     directive (host died after create,
//                                     before the directive committed):
//                                     re-tick via runFSM.
//
// Idempotency: resume performs NONE of run_task's create-time bookkeeping
// — it writes no idempotency-ledger row and persists no step_index, and it
// never advances past the current pause. The terminal / no-task / pending
// / ask forms touch no transaction at all; only the final runFSM fallback
// re-runs a tick, and that is reachable only when no directive was ever
// produced, where the per-tick atomic transaction plus re-delivery dedup
// keep a repeat safe.
//
// Kernel-coded failures (a non-idempotent provider on the pending path, an
// unregistered gate stage, a missing registry) are error-shaped wire
// envelopes; only programmer errors throw.

import {
  assertProjectDirAllowed,
  captureNow,
  KernelError,
  loadState,
  openDb,
  peekArchiveSlot,
  TransactionImpl,
  type PipelineState,
  type Registry,
} from "@loomfsm/kernel";
import { createTransportAdapter, resumeDirective } from "@loomfsm/driver";
import type { TransportResponse } from "@loomfsm/transport-types";

import { refuseTransport, transportError } from "../lib/refusal.js";
import type { ResumeInput, ResumeResponse, ToolHandler } from "../types.js";

export interface ResumeDeps {
  // Resolve the FSM registry for a project. The pending re-shuttle, the
  // ask re-derive, and the re-tick fallback all need a registry; absent →
  // those paths refuse with REGISTRY_UNAVAILABLE. The no-task and terminal
  // forms shape their response without a registry, so they proceed
  // regardless. Mirrors run-task / recover wiring (prod = assembleRegistry).
  resolveRegistry?: (projectDir: string) => Promise<Registry> | Registry;
  // Allowlist file override threaded to assertProjectDirAllowed. Tests
  // point at a tmpfile; production omits it and gets the default.
  allowlistPath?: string;
}

const UNKNOWN_DRIVER = "d-unknown";

export function createResumeTool(
  deps: ResumeDeps = {},
): ToolHandler<ResumeInput, ResumeResponse> {
  const adapter = createTransportAdapter();

  return async (input) => {
    // The driver_state_id echoed on a pre-load refusal: the caller's hint
    // if any, else a placeholder. Once state loads, the canonical id wins.
    const fallbackDriver =
      typeof input.driver_state_id === "string" && input.driver_state_id.length > 0
        ? input.driver_state_id
        : UNKNOWN_DRIVER;

    // 1. Project-dir allowlist.
    try {
      await assertProjectDirAllowed(
        input.project_dir,
        deps.allowlistPath !== undefined ? { allowlistPath: deps.allowlistPath } : undefined,
      );
    } catch (err) {
      return refusal(err, fallbackDriver);
    }

    // 2. Peek the slot WITHOUT opening (and so migrating into existence) a
    //    store for a project that never ran a task — a fresh project must
    //    answer NO_ACTIVE_TASK, not silently gain an empty state.db.
    let slot: Awaited<ReturnType<typeof peekArchiveSlot>>;
    try {
      slot = await peekArchiveSlot(input.project_dir);
    } catch (err) {
      return refusal(err, fallbackDriver);
    }
    if (slot === null) {
      return {
        response: transportError(
          fallbackDriver,
          "NO_ACTIVE_TASK",
          "no active task in this project to resume",
        ),
      };
    }

    // 3. The store exists — load the canonical snapshot read-only.
    const loaded = await readState(input.project_dir);
    const driverStateId = loaded.driver_state_id;

    // 4. Terminal — the task already finished; re-emit a complete envelope
    //    so the host stops driving. No registry needed.
    if (loaded.status === "completed" || loaded.status === "abandoned") {
      return { response: completeResponse(loaded) };
    }

    // 5. In-progress: every remaining form re-shapes a directive, which
    //    needs the registry to resolve providers / agents / the gate stage.
    if (deps.resolveRegistry === undefined) {
      return {
        response: transportError(
          driverStateId,
          "REGISTRY_UNAVAILABLE",
          "no registry resolver is wired for resume",
        ),
      };
    }

    let response: TransportResponse;
    try {
      const registry = await deps.resolveRegistry(input.project_dir);
      const directive = await resumeDirective(loaded, registry);
      response = adapter.shape(directive, { driver_state_id: driverStateId });
    } catch (err) {
      if (!(err instanceof KernelError)) throw err;
      response = transportError(driverStateId, err.code, err.message);
    }

    return { response };
  };
}

// A terminal task re-emits a `complete` envelope. An abandoned task has a
// NULL verdict; the wire `complete` form has no null verdict, so it maps to
// 'rejected' (the abandon-intent terminal), mirroring the recovery path.
function completeResponse(state: PipelineState): TransportResponse {
  return {
    status: "complete",
    task_id: state.task_id,
    verdict: state.verdict ?? "rejected",
    summary: state.status === "completed" ? "task already completed" : "task already abandoned",
  };
}

// Read the canonical state through a read-only TransactionImpl — the
// handler never commits this scope, so the now token threaded here is
// local and not observable on disk.
async function readState(projectDir: string): Promise<PipelineState> {
  const db = openDb(projectDir);
  const tx = new TransactionImpl(db, captureNow());
  return await loadState(tx);
}

// Map a thrown KernelError into an error-shaped wire envelope; rethrow
// anything that is not a kernel-coded refusal (programmer error).
function refusal(err: unknown, driverStateId: string): ResumeResponse {
  return refuseTransport(err, driverStateId);
}
