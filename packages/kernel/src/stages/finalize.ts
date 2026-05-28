// FinalizeStage interpreter — FSM terminator.
//
// Refuses to complete a task whose verdict is null (the inconsistent-
// finalize invariant the spec calls `INV_inconsistent-finalize`).
// Closes any non-terminal phase rows idempotently — phases left in
// `pending` or `in_progress` at the finalize boundary get marked
// `skipped` with a reason explaining the early termination, so
// audit log readers can see what state the kernel walked over.
// Then sets `pipeline_state.status = 'completed'` and
// `ended_at = tx.now` before returning the `complete` directive.

import { getKernelTx } from "../fsm.js";
import type { StageContext } from "../types/context.js";
import type { FinalizeStage, StageResult } from "../types/plugins.js";
import type { PipelineState } from "../types/state.js";

export async function interpretFinalize(
  _stage: FinalizeStage,
  state: PipelineState,
  ctx: StageContext,
): Promise<StageResult> {
  if (state.verdict === null) {
    return {
      type: "halt",
      directive: {
        code: "INV_INCONSISTENT_FINALIZE",
        message: "FinalizeStage entered with verdict=null",
        recovery_options: [],
      },
    };
  }

  const tx = getKernelTx(ctx);

  // Sweep any non-terminal phase rows. Idempotent: a phase already
  // marked `completed` or `skipped` is left as-is.
  for (const phase of state.phases) {
    if (phase.status === "completed" || phase.status === "skipped") continue;
    await tx.exec(
      "UPDATE phases SET status = ?, skipped_reason = ?, updated_at = ? WHERE name = ?",
      ["skipped", "swept by finalize", ctx.now, phase.name],
    );
  }

  await tx.exec(
    "UPDATE pipeline_state SET status = 'completed', ended_at = ? WHERE id = 1",
    [ctx.now],
  );

  // Mutate the in-memory state so the outer loop sees the terminal
  // status immediately — the runFSM caller treats the `complete`
  // directive as the exit signal regardless.
  state.status = "completed";
  state.ended_at = ctx.now;

  return {
    type: "complete",
    directive: {
      task_id: state.task_id,
      verdict: state.verdict,
      summary: `task complete (verdict=${state.verdict})`,
    },
  };
}
