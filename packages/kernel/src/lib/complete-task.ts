// Shared task-completion writer.
//
// Sweeps every non-terminal phase to `skipped` (with a reason) and writes
// the resolved verdict + `status='completed'` in the caller's open tx, so
// `INV_007` (verdict != null → every phase terminal) holds on commit. Two
// call sites use this: `interpretFinalize` (the FSM terminator) and the
// human-answer delivery path's gate `on_resume` → `complete` branch — both
// must land a verdict atomically with a phase sweep, so the rule lives in
// one place.
//
// Wall-clock discipline: the timestamp comes from the caller's `now`.

import type { PhaseRow } from "../types/row-types.js";
import type { Transaction } from "../types/transaction.js";

export type CompletionVerdict = "accepted" | "rejected" | "failed_force_closed";

export async function completeTask(
  tx: Transaction,
  phases: PhaseRow[],
  verdict: CompletionVerdict,
  now: string,
  reason: string,
): Promise<void> {
  // Sweep any non-terminal phase rows. Idempotent: a phase already
  // marked `completed` or `skipped` is left as-is.
  for (const phase of phases) {
    if (phase.status === "completed" || phase.status === "skipped") continue;
    await tx.exec(
      "UPDATE phases SET status = ?, skipped_reason = ?, updated_at = ? WHERE name = ?",
      ["skipped", reason, now, phase.name],
    );
  }

  await tx.exec(
    "UPDATE pipeline_state SET status = 'completed', verdict = ?, ended_at = ? WHERE id = 1",
    [verdict, now],
  );
}
