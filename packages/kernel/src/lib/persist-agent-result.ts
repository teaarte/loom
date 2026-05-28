// Persist an `AgentResult` to the kernel-owned tables inside the
// caller's open transaction.
//
// Five things happen here, in order:
//   1. INSERT into `agent_records` (one row per delivered result).
//   2. DELETE FROM `pending_agents` (drains the spawn row).
//   3. UPDATE `pipeline_counters` (agents_count + token rollup).
//   4. For reviewer/validator: INSERT findings + INSERT agent_verdicts.
//   5. For classifier: merge parsed header into `pipeline_state.decisions`.
//      For nonreview: nothing beyond steps 1-3.
//
// The idempotency-ledger row (`agent-result:<arid>`) is NOT written
// here. The caller's tx commits the persist work AND the ledger row
// in the same SQLite transaction — splitting "what to persist" from
// "is this delivery a dedupe target" keeps this helper reusable from
// the spawn-result path, the fanout-batch path, and the test harness
// without baking ledger semantics into each call site.
//
// Wall-clock discipline: every timestamp passed to the database comes
// from `tx.now`. No `Date.now()` / `new Date()` anywhere in the hot
// path — the lint enforces this; replay verdicts depend on it.

import { makeFindingId } from "../ids.js";
import type { AgentResult } from "../types/agent-result.js";
import type { Finding } from "../types/findings.js";
import type { AgentOutputKind } from "../types/plugins.js";
import type { Phase, ModelName } from "../types/row-types.js";
import type { Transaction } from "../types/transaction.js";

export interface PersistAgentResultArgs {
  result: AgentResult;
  output_kind: AgentOutputKind;
  phase: Phase;
  model: ModelName | null;
  iteration?: number;
}

export async function persistAgentResult(
  tx: Transaction,
  args: PersistAgentResultArgs,
): Promise<void> {
  const { result, output_kind, phase, model } = args;
  const iteration = args.iteration ?? 1;
  const now = tx.now;

  // 1. agent_records — one row per delivered result, including
  //    schema-invalid ones (kept for forensics; findings stay empty).
  await tx.exec(
    "INSERT INTO agent_records (phase, agent, agent_run_id, model, output_kind, " +
      "tokens_in, tokens_out, tokens_cached, recorded_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      phase,
      result.agent,
      result.agent_run_id,
      model,
      output_kind,
      result.tokens?.in ?? null,
      result.tokens?.out ?? null,
      result.tokens?.cached ?? null,
      now,
    ],
  );

  // 2. Drain the pending row. Closes INV_012 for this phase if it
  //    was the last spawn keeping the phase pending.
  await tx.exec(
    "DELETE FROM pending_agents WHERE agent_run_id = ?",
    [result.agent_run_id],
  );

  // 3. Counters — agents_count and token rollup. Counters table is
  //    pre-seeded with id=1; UPDATE never inserts.
  const ti = result.tokens?.in ?? 0;
  const to = result.tokens?.out ?? 0;
  const tc = result.tokens?.cached ?? 0;
  await tx.exec(
    "UPDATE pipeline_counters SET " +
      "agents_count = agents_count + 1, " +
      "total_tokens_in = total_tokens_in + ?, " +
      "total_tokens_out = total_tokens_out + ?, " +
      "total_tokens_cached = total_tokens_cached + ? " +
      "WHERE id = 1",
    [ti, to, tc],
  );

  // 4. Schema-invalid deliveries stop here — agent_records carries the
  //    forensic row; findings and verdicts stay empty. Audit emission
  //    is the caller's job (interpretSpawn / interpretFanout) so the
  //    same persistor serves both single + fanout paths.
  if (result.schema_validation.ok === false) return;

  if (output_kind === "reviewer" || output_kind === "validator") {
    await persistFindingsAndVerdict(tx, result, phase, iteration);
    return;
  }

  if (output_kind === "classifier") {
    await mergeClassifierDecisions(tx, result.parsed_header);
    return;
  }
  // nonreview + any bundle-extended output_kind: kernel has no
  // additional opinion. Bundle-owned persistence (when extends_vocab
  // adds an output_kind) runs via an event-position StepStage
  // subscribed to `after-agent-result` filtered by the kind.
}

async function persistFindingsAndVerdict(
  tx: Transaction,
  result: AgentResult,
  phase: Phase,
  iteration: number,
): Promise<void> {
  const findings = result.findings ?? [];
  let blocking = 0;
  let warn = 0;
  let info = 0;
  const categoriesSeen = new Set<string>();

  for (const finding of findings) {
    const id = finding.id.length > 0 ? finding.id : makeFindingId(tx.now);
    await tx.exec(
      "INSERT INTO findings (id, task_id, agent, iteration, phase, file, " +
        "line_start, line_end, severity, category, proposed_new_category, " +
        "pattern_id, summary, evidence_excerpt, suggested_fix, status, " +
        "ref_rule_id, recorded_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        nullIfEmpty(finding.task_id),
        finding.agent,
        finding.iteration,
        phase,
        finding.file,
        finding.line_start,
        finding.line_end,
        finding.severity,
        finding.category,
        finding.proposed_new_category,
        finding.pattern_id,
        finding.summary,
        finding.evidence_excerpt,
        finding.suggested_fix,
        finding.status,
        finding.ref_rule_id,
        tx.now,
      ],
    );
    if (finding.severity === "blocking") blocking += 1;
    else if (finding.severity === "warn") warn += 1;
    else info += 1;
    if (finding.category.length > 0) categoriesSeen.add(finding.category);
  }

  const verdict = deriveVerdict(result, findings);
  const summaryLine = deriveSummaryLine(result.parsed_header);

  await tx.exec(
    "INSERT INTO agent_verdicts (phase, agent, iteration, verdict, summary_line, " +
      "blocking_issues, warn_issues, info_issues, categories_seen, recorded_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      phase,
      result.agent,
      iteration,
      verdict,
      summaryLine,
      blocking,
      warn,
      info,
      JSON.stringify([...categoriesSeen]),
      tx.now,
    ],
  );
}

function deriveVerdict(
  result: AgentResult,
  findings: Finding[],
): string {
  const headerVerdict = result.parsed_header?.["verdict"];
  if (typeof headerVerdict === "string" && headerVerdict.length > 0) {
    return headerVerdict;
  }
  // Fallback: derive from findings — APPROVE if zero blocking, else
  // REQUEST_CHANGES. Bundles that need a different default verb ship
  // an `after-agent-result` event-position Step that rewrites the row.
  const anyBlocking = findings.some((f) => f.severity === "blocking");
  return anyBlocking ? "REQUEST_CHANGES" : "APPROVE";
}

function deriveSummaryLine(
  header: Record<string, unknown> | undefined,
): string | null {
  if (header === undefined) return null;
  const v = header["summary"];
  return typeof v === "string" ? v : null;
}

async function mergeClassifierDecisions(
  tx: Transaction,
  header: Record<string, unknown> | undefined,
): Promise<void> {
  if (header === undefined) return;
  // The classifier writes the entire decision header into
  // `pipeline_state.decisions`. We materialize the current row, merge
  // the header keys in, and write the new JSON back. `json_patch` is
  // the future shape; today's full re-serialize keeps the migration
  // out of K-scope while preserving the same observable behavior.
  const row = await tx.queryRow<{ decisions: string | null }>(
    "SELECT decisions FROM pipeline_state WHERE id = 1",
  );
  let current: Record<string, unknown> = {};
  if (row?.decisions !== null && row?.decisions !== undefined) {
    try {
      const parsed = JSON.parse(row.decisions) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt JSON should never reach here — pipeline_state.decisions
      // CHECK(json_valid) refuses writes that would. If it somehow does,
      // overwriting is safer than aborting the whole delivery.
      current = {};
    }
  }
  const merged: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(header)) {
    if (k === "verdict" || k === "summary" || k === "findings") continue;
    merged[k] = v;
  }
  await tx.exec(
    "UPDATE pipeline_state SET decisions = ? WHERE id = 1",
    [JSON.stringify(merged)],
  );
}

function nullIfEmpty(v: string): string | null {
  return v.length === 0 ? null : v;
}
