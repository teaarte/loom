// Phase-status progression — drives the `phases` table as the flow runs.
//
// Without this, the phase rows seed all-`pending` at task-create and the
// only writer during a run is the finalize sweep, so a clean accepted run
// ends with every phase `skipped` and never shows `completed`. The phase
// status then carries no progress signal and the "completed phase → agent
// records exist" invariant is satisfied only vacuously.
//
// The walk is driven from flow position, not from an in-memory cursor, so
// it survives the host round-trips that split a flow across many FSM
// passes:
//
//   - On entry to a stage, its phase moves `pending → in_progress`. A
//     phase re-entered after a walk-back (its status is `completed`) is
//     re-opened to `in_progress` so the re-run's spawns do not trip the
//     "terminal phase → no pending agents" invariant. A `skipped` phase is
//     left alone — skipped is a deliberate "this phase did not run" mark,
//     not a checkpoint to reopen.
//   - When the flow leaves a phase (the previous flow step's phase differs
//     from the current step's), that phase settles: `completed` when it has
//     agent records, `skipped` (with a reason) when it ran no agents — so
//     the completed-phase invariant always has real records behind it.
//
// Writes co-commit inside the active stage's transaction and mirror onto
// the in-memory snapshot so the finalize sweep and the invariant pass both
// read the same statuses. Every timestamp is `tx.now`; no wall clock.

import type { Stage } from "../types/plugins.js";
import type { Phase } from "../types/row-types.js";
import type { PipelineState } from "../types/state.js";
import type { Transaction } from "../types/transaction.js";

// FinalizeStage carries no phase; a StepStage's phase is optional. Both
// resolve to the empty string, which names no phase row.
function phaseOfStage(stage: Stage | undefined): Phase {
  if (stage === undefined) return "";
  if (stage.kind === "finalize") return "";
  if (stage.kind === "step") return stage.phase ?? "";
  return stage.phase;
}

async function setPhaseStatus(
  tx: Transaction,
  state: PipelineState,
  phase: Phase,
  status: "in_progress" | "completed" | "skipped",
  skippedReason: string | null,
): Promise<void> {
  await tx.exec(
    "UPDATE phases SET status = ?, skipped_reason = ?, updated_at = ? WHERE name = ?",
    [status, skippedReason, tx.now, phase],
  );
  const row = state.phases.find((p) => p.name === phase);
  if (row !== undefined) {
    row.status = status;
    row.skipped_reason = skippedReason;
    row.updated_at = tx.now;
  }
}

// Settle the phase the flow is leaving: completed when it produced agent
// records, skipped (with a reason) when it did not. Idempotent — a phase
// already terminal is left untouched.
async function leavePhase(
  tx: Transaction,
  state: PipelineState,
  phase: Phase,
): Promise<void> {
  if (phase === "") return;
  const row = state.phases.find((p) => p.name === phase);
  if (row === undefined || row.status !== "in_progress") return;
  const countRow = await tx.queryRow<{ c: unknown }>(
    "SELECT COUNT(*) AS c FROM agent_records WHERE phase = ?",
    [phase],
  );
  const hasRecords = countRow !== null && Number(countRow.c) > 0;
  if (hasRecords) {
    await setPhaseStatus(tx, state, phase, "completed", null);
  } else {
    await setPhaseStatus(tx, state, phase, "skipped", "no agents ran in this phase");
  }
}

// Mark the entered phase in_progress. Reopens a completed phase (walk-back
// re-entry) but never a skipped one.
async function enterPhase(
  tx: Transaction,
  state: PipelineState,
  phase: Phase,
): Promise<void> {
  if (phase === "") return;
  const row = state.phases.find((p) => p.name === phase);
  if (row === undefined) return;
  if (row.status === "pending" || row.status === "completed") {
    await setPhaseStatus(tx, state, phase, "in_progress", null);
  }
}

// Drive the phase walk for the stage about to run at `stepIndex`. Called at
// the top of every stage transaction. Settles the phase the flow just left
// (if the previous flow step is in a different phase) and opens the current
// phase. Assumes a phase's stages are contiguous in the flow — the leave is
// keyed on an adjacent phase change, which is how the stock flows are built.
export async function advancePhaseProgress(
  tx: Transaction,
  state: PipelineState,
  flow: readonly string[],
  stepIndex: number,
  stagesByName: Map<string, Stage>,
): Promise<void> {
  const currentName = flow[stepIndex];
  if (currentName === undefined) return;
  const currentPhase = phaseOfStage(stagesByName.get(currentName));

  if (stepIndex > 0) {
    const prevName = flow[stepIndex - 1];
    const prevPhase = phaseOfStage(
      prevName === undefined ? undefined : stagesByName.get(prevName),
    );
    if (prevPhase !== "" && prevPhase !== currentPhase) {
      await leavePhase(tx, state, prevPhase);
    }
  }

  await enterPhase(tx, state, currentPhase);
}
