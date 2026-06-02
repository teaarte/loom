// Durably record the FSM driver's resume point after a tick.
//
// `runFSM` advances `step_index` only in memory as it walks past the
// positional step-stages within a single tick; the value persisted on
// disk moves by exactly one per delivery (the drain-advance inside
// `deliverContinue`). When two spawn/gate stages are adjacent in a flow
// those two agree, so the resume point is correct without help. But a
// flow that interleaves positional steps between spawns — read a diff,
// derive review flags, snapshot state — would, on the next delivery,
// only advance the persisted index by one and re-enter the just-emitted
// spawn, re-issuing it once per intervening step.
//
// Persisting the tick's paused index (the stage that produced the
// returned directive) closes that gap so every spawn is issued exactly
// once. It is a no-op when the paused index already equals the stored
// one, so flows without interleaved steps are unaffected.

import type { Transaction } from "@loomfsm/kernel";

export async function persistDriverStepIndex(
  tx: Transaction,
  stepIndex: number,
): Promise<void> {
  await tx.exec("UPDATE driver_state SET step_index = ? WHERE id = 1", [stepIndex]);
}
