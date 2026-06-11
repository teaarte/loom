// Finding-iteration provenance + the walk-back supersede resolver.
//
// Two facts the kernel owns, both generic over the `findings.{phase,
// iteration, severity, status}` columns — no domain concept appears here:
//
//   1. The per-phase iteration counter `phase_iter_<phase>` on
//      `driver_state.scratch` (a sibling of `fanout_iter_<stage>`). It
//      tracks which round of a phase is currently live, so a finding's
//      `iteration` is KERNEL-stamped from this counter rather than
//      trusted from the agent's self-report. Absent counter ⇒ round 1.
//
//   2. On a walk-back (a gate rejection re-running the flow), every phase
//      the flow re-executes from the walk-back target through the current
//      step is a NEW round: its counter bumps and its prior-round LIVE
//      findings are linked to the new iteration via
//      `superseded_by_iteration`. A superseded finding is no longer live,
//      so a stale open blocker from a replaced round can neither be
//      counted against the gate nor block a final acceptance.
//
// The span (target‥current) — not just the single walk-back-target stage —
// is what re-runs: a walk-back to an early stage re-executes EVERY phase
// between it and the rejecting gate, not only the target stage's own phase.
// Superseding just the target's phase would leave a later span phase's
// prior-round blocker live across an otherwise-clean re-run, and that stale
// blocker would then veto a legitimate acceptance.
//
// Wall-clock discipline: supersede carries no timestamp of its own — the
// linkage IS the iteration number — so nothing here reads the host clock.

import type { Stage } from "../types/plugins.js";
import type { Transaction } from "../types/transaction.js";

// `driver_state.scratch` key holding the live iteration of a phase.
export function phaseIterKey(phase: string): string {
  return `phase_iter_${phase}`;
}

// Read the live iteration of a phase off a scratch snapshot. Absent /
// non-numeric ⇒ 1 (the first round), matching the pre-supersede default
// where every finding carried iteration 1.
export function readPhaseIter(
  scratch: Record<string, unknown>,
  phase: string,
): number {
  const raw = scratch[phaseIterKey(phase)];
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 1
    ? raw
    : 1;
}

export interface SupersedeWalkBackArgs {
  // The active flow's ordered stage names.
  flow: readonly string[];
  // Stage lookup so each span position resolves to its phase.
  stages: ReadonlyMap<string, Stage>;
  // Flow index walked back TO (inclusive) and the index walked back FROM
  // (the rejecting gate's position, inclusive). Every phase appearing in
  // `flow[target‥current]` is re-run.
  targetIndex: number;
  currentIndex: number;
  // Current `driver_state.scratch` (carries the per-phase counters). Merged
  // and rewritten — the caller passes the in-memory snapshot so the bumped
  // counters can be mirrored back onto it.
  scratch: Record<string, unknown>;
}

// Co-committed with the walk-back step_index write. Bumps `phase_iter` for
// every phase in the re-run span and links that span's prior-round LIVE
// findings to the bumped iteration. Returns the merged scratch so the
// caller mirrors it onto the in-memory state.
//
// Idempotent on a retried delivery: the UPDATE only touches rows still
// `superseded_by_iteration IS NULL`, so a second application finds nothing
// to retire (the counter bump follows the same in-tx pattern as the gate's
// auto-rejection counter — it rides the once-per-delivery ledger guard).
export async function supersedeFindingsOnWalkBack(
  tx: Transaction,
  args: SupersedeWalkBackArgs,
): Promise<Record<string, unknown>> {
  const { flow, stages, targetIndex, currentIndex } = args;
  const lo = Math.max(0, targetIndex);
  const hi = Math.min(flow.length - 1, currentIndex);

  // Distinct non-empty phases the flow re-executes across the span.
  const rerunPhases = new Set<string>();
  for (let i = lo; i <= hi; i++) {
    const name = flow[i];
    if (name === undefined) continue;
    const stage = stages.get(name);
    if (stage === undefined) continue;
    const phase = stagePhase(stage);
    if (phase.length > 0) rerunPhases.add(phase);
  }

  const merged: Record<string, unknown> = { ...args.scratch };
  for (const phase of rerunPhases) {
    const nextIter = readPhaseIter(args.scratch, phase) + 1;
    // Retire every LIVE finding of this phase from a prior round, linking
    // it to the round that replaces it. `iteration < nextIter` is implied
    // by liveness (live rows carry iteration ≤ nextIter-1) but stated so
    // the intent reads off the WHERE clause.
    await tx.exec(
      "UPDATE findings SET superseded_by_iteration = ? " +
        "WHERE phase = ? AND superseded_by_iteration IS NULL AND iteration < ?",
      [nextIter, phase, nextIter],
    );
    merged[phaseIterKey(phase)] = nextIter;
  }

  if (rerunPhases.size > 0) {
    await tx.exec("UPDATE driver_state SET scratch = ? WHERE id = 1", [
      JSON.stringify(merged),
    ]);
  }
  return merged;
}

// Resolve a stage's phase for the span scan. FinalizeStage carries no
// phase; a StepStage's is optional — both fall back to the empty string
// the span scan skips (no findings are keyed to a phase-less stage).
function stagePhase(stage: Stage): string {
  if (stage.kind === "finalize") return "";
  if (stage.kind === "step") return stage.phase ?? "";
  return stage.phase;
}

// ============================================================================
// Open-blocker hand-off — deliver a gate rejection's blockers to the rework
// ============================================================================
//
// A walk-back retires the rejecting round's findings so a stale blocker cannot
// haunt the next round (see the supersede resolver above). But the agent the
// flow re-enters on — the one asked to FIX those blockers — must still learn
// what they were, or it re-runs against a byte-identical prompt and the rework
// loop converges only by luck. So at the gate, BEFORE the supersede retires
// them, the live open blockers are snapshotted into the driver scratch; the
// prompt renderer reads that snapshot and lists it under "### Open blockers" in
// the next spawn context. The snapshot is plain text (file / line / category /
// summary / suggested fix) — it is delivery context, never re-counted against a
// gate (gating still reads the live findings table). It is overwritten on the
// next rejection and cleared when a gate approves, so an agent only ever sees
// the blockers it is currently being asked to resolve.

// `driver_state.scratch` key holding the most recent gate rejection's open
// blocking findings, captured before they are superseded.
export const OPEN_BLOCKERS_KEY = "open_blockers";

// The compact projection a fixer needs — no provenance columns, no ids.
export interface OpenBlocker {
  file: string | null;
  line: number | null;
  category: string;
  summary: string;
  suggested_fix: string | null;
  agent: string;
}

interface OpenBlockerRow {
  file: string | null;
  line_start: number | null;
  category: unknown;
  summary: unknown;
  suggested_fix: string | null;
  agent: unknown;
}

// Capture every LIVE open blocking finding (open + blocking + non-superseded)
// into the driver scratch so the re-entered flow's first spawn renders them.
// Co-committed in the gate's walk-back tx, BEFORE `supersedeFindingsOnWalkBack`
// retires the same rows — order matters: read them while they are still live.
// Returns the merged scratch so the caller threads it into the supersede write
// that follows (which rewrites the whole scratch blob and would otherwise drop
// this key). Carries no timestamp — nothing here reads the host clock.
export async function snapshotOpenBlockers(
  tx: Transaction,
  scratch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const rows = await tx.queryAll<OpenBlockerRow>(
    "SELECT file, line_start, category, summary, suggested_fix, agent " +
      "FROM findings WHERE severity = 'blocking' AND status = 'open' " +
      "AND superseded_by_iteration IS NULL ORDER BY id ASC",
  );
  const blockers: OpenBlocker[] = rows.map((r) => ({
    file: r.file === null ? null : String(r.file),
    line: r.line_start === null ? null : Number(r.line_start),
    category: String(r.category),
    summary: String(r.summary),
    suggested_fix: r.suggested_fix === null ? null : String(r.suggested_fix),
    agent: String(r.agent),
  }));
  const merged = { ...scratch, [OPEN_BLOCKERS_KEY]: blockers };
  await tx.exec("UPDATE driver_state SET scratch = ? WHERE id = 1", [
    JSON.stringify(merged),
  ]);
  return merged;
}

// Drop the open-blocker snapshot when a gate approves — the blockers the agent
// was asked to fix are settled, so the next spawn must not still list them.
// A no-op (no write) when the key is absent. Returns the merged scratch.
export async function clearOpenBlockers(
  tx: Transaction,
  scratch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!(OPEN_BLOCKERS_KEY in scratch)) return scratch;
  const merged = { ...scratch };
  delete merged[OPEN_BLOCKERS_KEY];
  await tx.exec("UPDATE driver_state SET scratch = ? WHERE id = 1", [
    JSON.stringify(merged),
  ]);
  return merged;
}
