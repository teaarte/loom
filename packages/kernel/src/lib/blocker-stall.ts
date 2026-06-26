// Per-blocker stall breaker.
//
// The global replan cap (gate-policy.ts) bounds TOTAL auto-rejections at a
// gate, but it cannot tell "making progress through different blockers" from
// "stuck on the exact same one". A rework loop that re-drives the implementer
// against an unchanged blocker set is not converging — re-running it again
// only burns tokens. This breaker fingerprints the live open CODE blockers
// each auto-reject round; when the set repeats unchanged for STALL_THRESHOLD
// consecutive rounds it escalates to a human instead of walking back again.
//
// Generic + domain-blind: it reads only the kernel-native
// `findings.{severity,status,superseded_by_iteration,origin,category,file,
// line_start,agent}` columns and never names a domain concept. Harness
// blockers are excluded — those already route to a human at the gate, so a
// stall here is specifically a code blocker the rework loop cannot clear.
//
// Wall-clock discipline: a pure read + a scratch write; no clock, no
// randomness — the same rounds replay to the same stall verdict.

import type { Transaction } from "../types/transaction.js";

// Consecutive identical-blocker rounds that trip the breaker. Round 1
// produces a blocker set and the rework loop runs; if round 2 produces the
// byte-identical set, the loop has not converged → escalate. Deliberately
// tighter than the global replan cap so a genuine stall is caught first.
export const STALL_THRESHOLD = 2;

// `driver_state.scratch` keys. Siblings of the other kernel-owned scratch
// counters (phase_iter_*, schema_retry_*, open_blockers).
const STALL_FP_KEY = "stall_blocker_fp";
const STALL_COUNT_KEY = "stall_blocker_count";

export interface BlockerStallResult {
  // Merged scratch the caller mirrors onto in-memory state.
  scratch: Record<string, unknown>;
  // True once the same non-empty blocker set has recurred STALL_THRESHOLD
  // times — the gate should escalate to a human rather than walk back.
  stalled: boolean;
  // Consecutive rounds the current set has been live (≥1).
  count: number;
  // Human-readable escalation message listing the stuck blockers.
  feedback: string;
}

interface BlockerRow {
  category: unknown;
  file: unknown;
  line_start: unknown;
  agent: unknown;
  summary: unknown;
}

// Evaluate + advance the stall counter for the current round, co-committed in
// the gate's tx. Call only on an auto-reject that would walk back.
export async function evaluateBlockerStall(
  tx: Transaction,
  scratch: Record<string, unknown>,
): Promise<BlockerStallResult> {
  const rows = await tx.queryAll<BlockerRow>(
    "SELECT category, file, line_start, agent, summary FROM findings " +
      "WHERE severity = 'blocking' AND status = 'open' " +
      "AND superseded_by_iteration IS NULL AND origin = 'code' " +
      "ORDER BY category, file, line_start, agent",
  );

  // Identity of a blocker across rounds: its location + category + author.
  // The summary text is excluded from the fingerprint (an agent may reword
  // it) but kept for the operator-facing message.
  const fingerprint = rows
    .map(
      (r) =>
        `${String(r.category)}|${r.file === null ? "" : String(r.file)}|` +
        `${r.line_start === null ? "" : String(r.line_start)}|${String(r.agent)}`,
    )
    .join("\n");

  const prevFp = typeof scratch[STALL_FP_KEY] === "string" ? (scratch[STALL_FP_KEY] as string) : "";
  const prevCount =
    typeof scratch[STALL_COUNT_KEY] === "number" && Number.isFinite(scratch[STALL_COUNT_KEY])
      ? (scratch[STALL_COUNT_KEY] as number)
      : 0;

  // An empty set (no live code blockers — e.g. an acceptance-only reject)
  // cannot stall; it resets the counter and defers to the global replan cap.
  const recurred = fingerprint.length > 0 && fingerprint === prevFp;
  const count = recurred ? prevCount + 1 : 1;

  const merged = { ...scratch, [STALL_FP_KEY]: fingerprint, [STALL_COUNT_KEY]: count };
  await tx.exec("UPDATE driver_state SET scratch = ? WHERE id = 1", [JSON.stringify(merged)]);

  const stalled = fingerprint.length > 0 && count >= STALL_THRESHOLD;
  return { scratch: merged, stalled, count, feedback: buildFeedback(rows, count) };
}

function buildFeedback(rows: BlockerRow[], count: number): string {
  const list = rows
    .slice(0, 5)
    .map((r) => {
      const loc =
        r.file === null
          ? ""
          : ` @ ${String(r.file)}${r.line_start === null ? "" : `:${String(r.line_start)}`}`;
      return `- [${String(r.category)}]${loc}: ${String(r.summary)}`;
    })
    .join("\n");
  const more = rows.length > 5 ? `\n…and ${rows.length - 5} more.` : "";
  return (
    `The same ${rows.length} blocker(s) have persisted unchanged across ${count} ` +
    `consecutive rework rounds — the implement→review loop is not converging:\n` +
    `${list}${more}\n` +
    `Re-driving the implementer will not help. A human should fix these manually, ` +
    `accept them, or abandon the task.`
  );
}

// Drop the stall counters when a gate approves — the blockers cleared, so a
// later unrelated reject starts a fresh count. No-op (no write) when absent.
export async function clearBlockerStall(
  tx: Transaction,
  scratch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!(STALL_FP_KEY in scratch) && !(STALL_COUNT_KEY in scratch)) return scratch;
  const merged = { ...scratch };
  delete merged[STALL_FP_KEY];
  delete merged[STALL_COUNT_KEY];
  await tx.exec("UPDATE driver_state SET scratch = ? WHERE id = 1", [JSON.stringify(merged)]);
  return merged;
}
