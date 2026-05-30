// FinalizeStage interpreter — FSM terminator.
//
// A natural arrival at finalize with no verdict recorded means the flow
// advanced cleanly to its end — the rejection / abandon exits set their
// verdict explicitly through an `on_resume` `complete` or a recovery
// action and never reach here. So an unset verdict resolves to
// `accepted`, the same default the runFSM loop-exit applies; finalize
// persists it alongside completion so the stored row and the wire
// directive agree.
//
// Closes any non-terminal phase rows idempotently — phases left in
// `pending` or `in_progress` at the finalize boundary get marked
// `skipped` with a reason explaining the early termination, so
// audit log readers can see what state the kernel walked over. Writing
// the resolved verdict and the phase sweep in this one transaction keeps
// the `verdict != null → every phase terminal` invariant satisfied on
// commit.

import { getKernelTx } from "../fsm.js";
import type { StageContext } from "../types/context.js";
import type { FinalizeStage, StageResult } from "../types/plugins.js";
import type { PipelineState } from "../types/state.js";

export async function interpretFinalize(
  _stage: FinalizeStage,
  state: PipelineState,
  ctx: StageContext,
): Promise<StageResult> {
  const verdict = state.verdict ?? "accepted";

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
    "UPDATE pipeline_state SET status = 'completed', verdict = ?, ended_at = ? WHERE id = 1",
    [verdict, ctx.now],
  );

  // Mutate the in-memory state so the outer loop sees the terminal
  // status immediately — the runFSM caller treats the `complete`
  // directive as the exit signal regardless.
  state.status = "completed";
  state.verdict = verdict;
  state.ended_at = ctx.now;

  return {
    type: "complete",
    directive: {
      task_id: state.task_id,
      verdict,
      summary: `task complete (verdict=${verdict})`,
    },
  };
}
