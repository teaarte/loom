// Compute the generic WORK signal from the live findings ledger.
//
// `work_result` is orthogonal to the orchestration `verdict`: it answers
// "is the work itself clean", independent of how the orchestration ended.
// The kernel owns this without naming any domain concept — it reads only
// the generic `findings.{severity,status,superseded_by_iteration,origin}`
// columns:
//
//   clean   — no open blocking CODE finding remains. Harness blockers
//             (unparseable agent output, transport faults) are plumbing
//             failures, not facts about the work, so they do NOT mark the
//             work blocked — a force-close past a stuck harness loop on
//             otherwise-green work resolves to `clean`.
//   blocked — at least one open blocking code finding is live.
//
// No clock, no randomness — a pure read over the open tx, so a terminal
// boundary records the same value on replay.

import type { WorkResult } from "../types/state.js";
import type { Transaction } from "../types/transaction.js";

export async function computeWorkResult(tx: Transaction): Promise<WorkResult> {
  const row = await tx.queryRow<{ n: number }>(
    "SELECT COUNT(*) AS n FROM findings " +
      "WHERE severity = 'blocking' AND status = 'open' " +
      "AND superseded_by_iteration IS NULL AND origin = 'code'",
  );
  const openCodeBlockers = row === null ? 0 : Number(row.n);
  return openCodeBlockers === 0 ? "clean" : "blocked";
}
