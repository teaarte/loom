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
import { parseStateJson } from "../state/json.js";
import { assertVocabKnown } from "../vocabularies.js";
import type { AgentResult } from "../types/agent-result.js";
import type { Finding } from "../types/findings.js";
import type { AgentOutputKind } from "../types/plugins.js";
import type { Phase, ModelName } from "../types/row-types.js";
import type { Transaction } from "../types/transaction.js";
import type { KernelVocabularies } from "../types/vocabulary.js";

export interface PersistAgentResultArgs {
  result: AgentResult;
  output_kind: AgentOutputKind;
  phase: Phase;
  model: ModelName | null;
  iteration?: number;
  // Registry vocabularies for insert-time validation. Optional so the
  // many in-kernel harnesses that exercise unrelated persistence
  // behavior need not thread a set; the production delivery path always
  // supplies it (the same shape as the optional `resolveOutputKind`
  // resolver on the continue surface). When present, an `output_kind`
  // outside the merged set is refused with `VOCAB_UNKNOWN` before the
  // `agent_records` row lands.
  vocabularies?: KernelVocabularies;
  // Whether the caller can re-issue THIS spawn alone (a lone spawn can; a
  // fanout sibling cannot — re-interpreting the fanout re-spawns every
  // sibling). When true, an unparseable reviewer/validator output is tolerated
  // for ONE retry before it is turned into a blocking finding. Default false.
  allow_retry_reissue?: boolean;
}

export interface PersistAgentResultOutcome {
  // True when an unparseable reviewer/validator output was tolerated for one
  // retry: the spawn was drained (forensic row kept) but NO finding was
  // recorded, and the caller must NOT advance the step so the spawn re-issues.
  schema_retry_requested: boolean;
}

export async function persistAgentResult(
  tx: Transaction,
  args: PersistAgentResultArgs,
): Promise<PersistAgentResultOutcome> {
  const { result, output_kind, phase, model } = args;
  const iteration = args.iteration ?? 1;
  const now = tx.now;

  // Refuse an undeclared output_kind before writing the forensic row —
  // a bundle agent declaring an `output_kind` outside the merged
  // vocabulary would otherwise land silently in `agent_records`.
  if (args.vocabularies !== undefined) {
    assertVocabKnown(args.vocabularies.output_kinds, output_kind, "output_kind");
  }

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

  // 4. Schema-invalid handling. agent_records already carries the forensic
  //    row (above). For an agent whose output_kind CARRIES verdicts/findings
  //    (reviewer / validator), an unparseable output must never drain to a
  //    silent zero-finding pass — a gate would read "no blockers" and approve.
  //    So: ONE retry where the caller can safely re-issue the spawn, then a
  //    synthetic blocking finding recorded through the normal path so the gate
  //    sees it like any other blocker. A classifier / nonreview schema-invalid
  //    has no findings contract — it keeps the legacy forensic-only behavior.
  if (result.schema_validation.ok === false) {
    if (output_kind === "reviewer" || output_kind === "validator") {
      return await handleUnparseableReview(tx, {
        result,
        output_kind,
        phase,
        iteration,
        allow_retry_reissue: args.allow_retry_reissue ?? false,
      });
    }
    return { schema_retry_requested: false };
  }

  if (output_kind === "reviewer" || output_kind === "validator") {
    // A clean delivery clears any retry marker a prior unparseable attempt of
    // this (phase, agent) left, so a later re-review starts from a fresh count.
    await clearSchemaRetry(tx, phase, result.agent);
    await persistFindingsAndVerdict(tx, result, phase, iteration);
    return { schema_retry_requested: false };
  }

  if (output_kind === "classifier") {
    await mergeClassifierDecisions(tx, result.parsed_header);
    return { schema_retry_requested: false };
  }
  // nonreview + any bundle-extended output_kind: kernel has no
  // additional opinion. Bundle-owned persistence (when extends_vocab
  // adds an output_kind) runs via an event-position StepStage
  // subscribed to `after-agent-result` filtered by the kind.
  return { schema_retry_requested: false };
}

// ============================================================================
// Unparseable reviewer/validator output — retry once, then block (never pass)
// ============================================================================

interface UnparseableArgs {
  result: AgentResult;
  output_kind: AgentOutputKind;
  phase: Phase;
  iteration: number;
  allow_retry_reissue: boolean;
}

// The per-(phase, agent) retry counter lives on the driver scratch, a sibling
// of the other kernel-owned scratch counters. Keyed by phase+agent (not the
// agent_run_id) so it survives the re-issue, which mints a fresh id.
function schemaRetryKey(phase: string, agent: string): string {
  return `schema_retry_${phase}_${agent}`;
}

async function handleUnparseableReview(
  tx: Transaction,
  args: UnparseableArgs,
): Promise<PersistAgentResultOutcome> {
  const { result, output_kind, phase, iteration } = args;
  const key = schemaRetryKey(phase, result.agent);
  const scratch = await readDriverScratch(tx);
  const attempts = readRetryCount(scratch, key);

  // First failure on a re-issuable spawn: tolerate it once. Record the bump
  // and ask the caller to hold the step so the FSM re-interprets the stage and
  // re-runs the agent (the forensic row + drain already happened above).
  if (args.allow_retry_reissue && attempts < 1) {
    await writeRetryCount(tx, scratch, key, attempts + 1);
    return { schema_retry_requested: true };
  }

  // Retry exhausted, or a fanout sibling that cannot be re-issued alone:
  // synthesize a blocking finding so the gate cannot silently approve over an
  // output it could not read. Reset the counter so a future fresh attempt of
  // this (phase, agent) is not pre-blocked.
  await recordUnparseableBlocker(tx, {
    agent: result.agent,
    output_kind,
    phase,
    iteration,
    reason: unparseableReason(result),
  });
  await clearRetryCount(tx, scratch, key);
  return { schema_retry_requested: false };
}

function unparseableReason(result: AgentResult): string {
  return result.schema_validation.ok === false
    ? result.schema_validation.reason
    : "schema validation failed";
}

// Insert one blocking finding + its verdict row for an agent whose output
// could not be parsed — the same INSERT shape a real reviewer finding takes,
// so gates, policies, and the supersede resolver treat it identically. The
// finding is server-minted, server-stamped (id + iteration), attributed to the
// agent, and categorized `unparseable-output` so an operator sees WHY the gate
// held.
async function recordUnparseableBlocker(
  tx: Transaction,
  opts: {
    agent: string;
    output_kind: AgentOutputKind;
    phase: Phase;
    iteration: number;
    reason: string;
  },
): Promise<void> {
  const id = makeFindingId(tx.now);
  const summary = `Agent '${opts.agent}' returned output that could not be parsed as a review (${opts.reason}). Treated as a blocker so the result is not silently approved; re-run the agent or inspect manually — the implementer cannot fix this.`;
  // origin = 'harness': this is a plumbing failure, not a fact about the
  // code. A gate routes it to a human instead of the implement→review
  // rework loop (which cannot resolve a parse error).
  await tx.exec(
    "INSERT INTO findings (id, task_id, agent, iteration, phase, file, " +
      "line_start, line_end, severity, category, proposed_new_category, " +
      "pattern_id, summary, evidence_excerpt, suggested_fix, status, " +
      "ref_rule_id, origin, recorded_at) " +
      "VALUES (?, NULL, ?, ?, ?, NULL, NULL, NULL, 'blocking', " +
      "'unparseable-output', NULL, NULL, ?, NULL, NULL, 'open', NULL, 'harness', ?)",
    [id, opts.agent, opts.iteration, opts.phase, summary, tx.now],
  );
  // A reviewer's contradicting verdict normalizes to REQUEST_CHANGES; a
  // validator's to FAIL — the change-leaning verbs the gate reads, kept
  // consistent with the synthesized blocker.
  const verdict = opts.output_kind === "validator" ? "FAIL" : "REQUEST_CHANGES";
  await tx.exec(
    "INSERT INTO agent_verdicts (phase, agent, iteration, verdict, summary_line, " +
      "blocking_issues, warn_issues, info_issues, categories_seen, recorded_at) " +
      "VALUES (?, ?, ?, ?, ?, 1, 0, 0, ?, ?)",
    [
      opts.phase,
      opts.agent,
      opts.iteration,
      verdict,
      "unparseable output",
      JSON.stringify(["unparseable-output"]),
      tx.now,
    ],
  );
}

async function readDriverScratch(tx: Transaction): Promise<Record<string, unknown>> {
  const row = await tx.queryRow<{ scratch: string | null }>(
    "SELECT scratch FROM driver_state WHERE id = 1",
  );
  return parseStateJson<Record<string, unknown>>(row?.scratch ?? null, {});
}

function readRetryCount(scratch: Record<string, unknown>, key: string): number {
  const raw = scratch[key];
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

async function writeRetryCount(
  tx: Transaction,
  scratch: Record<string, unknown>,
  key: string,
  next: number,
): Promise<void> {
  const merged = { ...scratch, [key]: next };
  await tx.exec("UPDATE driver_state SET scratch = ? WHERE id = 1", [
    JSON.stringify(merged),
  ]);
}

async function clearRetryCount(
  tx: Transaction,
  scratch: Record<string, unknown>,
  key: string,
): Promise<void> {
  if (!(key in scratch)) return;
  const merged = { ...scratch };
  delete merged[key];
  await tx.exec("UPDATE driver_state SET scratch = ? WHERE id = 1", [
    JSON.stringify(merged),
  ]);
}

// Clear the retry marker for a (phase, agent) on a clean delivery — reads
// scratch first so a no-marker delivery (the overwhelming common case) costs
// one SELECT and no write.
async function clearSchemaRetry(
  tx: Transaction,
  phase: string,
  agent: string,
): Promise<void> {
  const key = schemaRetryKey(phase, agent);
  const scratch = await readDriverScratch(tx);
  await clearRetryCount(tx, scratch, key);
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
    // Finding identity is ALWAYS server-minted. A finding id is the only
    // row id that an LLM could otherwise author, and review agents fanned
    // out in parallel converge on the same example suffix — two siblings
    // emit the same id and collide on the findings PRIMARY KEY, rolling
    // back the whole batch delivery. Minting here (like every other row
    // id) makes collisions structurally impossible; any id the agent
    // supplied is ignored. The agent contract no longer asks for one.
    const id = makeFindingId(tx.now);
    // `iteration` is likewise KERNEL-stamped from the caller's per-phase
    // counter, not read from the agent's `finding.iteration` self-report:
    // the supersede resolver links retired rounds by iteration, so a value
    // the agent could fabricate would let a stale round masquerade as the
    // current one. A fresh row is always LIVE — `superseded_by_iteration`
    // defaults to NULL (omitted from the column list below).
    await tx.exec(
      "INSERT INTO findings (id, task_id, agent, iteration, phase, file, " +
        "line_start, line_end, severity, category, proposed_new_category, " +
        "pattern_id, summary, evidence_excerpt, suggested_fix, status, " +
        "ref_rule_id, origin, recorded_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        nullIfEmpty(finding.task_id),
        finding.agent,
        iteration,
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
        // Agent-reported findings are facts about the code. Only the
        // kernel mints `harness` (the unparseable-output blocker above).
        finding.origin ?? "code",
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
  const anyBlocking = findings.some((f) => f.severity === "blocking");
  // Findings-derived verdict — APPROVE if zero blocking, else
  // REQUEST_CHANGES. Bundles that need a different default verb ship
  // an `after-agent-result` event-position Step that rewrites the row.
  const derived = anyBlocking ? "REQUEST_CHANGES" : "APPROVE";

  const headerVerdict = result.parsed_header?.["verdict"];
  if (typeof headerVerdict !== "string" || headerVerdict.length === 0) {
    return derived;
  }

  // Verdict ⟺ findings cross-check. The reviewer contract is
  // "REQUEST_CHANGES iff at least one blocking finding". An agent that
  // returns REQUEST_CHANGES while reporting zero blocking findings
  // contradicts its own output; gating already decided correctly from the
  // server-side blocking count, so the stored verdict is the only thing
  // misrepresenting a clean result. Normalize it to the findings-derived
  // verdict so the persisted + surfaced verdict matches the counts and any
  // future verdict-keyed reader is not misled. Scoped to the reviewer
  // vocabulary so a validator's own verdict words (PASS/FAIL/…) are never
  // rewritten with a reviewer verb.
  if (headerVerdict.toUpperCase() === "REQUEST_CHANGES" && !anyBlocking) {
    return derived;
  }
  return headerVerdict;
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
  // The classifier writes its decision header into
  // `pipeline_state.decisions`: materialize the current row, merge the
  // header keys in, and write the whole object back (a full re-serialize —
  // the row is single-writer under this tx). An unparseable blob here is a
  // corrupted state row: the json_valid CHECK should have refused the write
  // that produced it, so reaching a parse failure means tampering or a
  // backend skew. `parseStateJson` fails loud (STATE_CORRUPT rolls this
  // delivery's tx back) rather than overwriting live decisions with `{}`
  // and silently dropping whatever was actually there.
  const row = await tx.queryRow<{ decisions: string | null }>(
    "SELECT decisions FROM pipeline_state WHERE id = 1",
  );
  const parsed = parseStateJson<unknown>(row?.decisions ?? null, null);
  const current: Record<string, unknown> =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const merged: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(header)) {
    if (k === "verdict" || k === "summary" || k === "findings") continue;
    merged[k] = v;
  }
  await tx.exec(
    "UPDATE pipeline_state SET decisions = ? WHERE id = 1",
    [JSON.stringify(merged)],
  );

  // Promote a classifier-derived `task_short` to the first-class column.
  // The label is unknown at task-create (the classifier derives it later), so
  // the column was seeded NULL and nothing else fills it — leaving the prompt
  // renderer's "Task (short)" section, the `{{task_short}}` substitution, and
  // the archival index empty. Promote here, guarded `task_short IS NULL`, so a
  // label the operator set explicitly at create time still wins. Deterministic
  // over the parsed header → replay-safe. The value also stays in `decisions`
  // (the merge above), so no existing decisions reader regresses.
  const shortLabel = header["task_short"];
  if (typeof shortLabel === "string" && shortLabel.length > 0) {
    await tx.exec(
      "UPDATE pipeline_state SET task_short = ? WHERE id = 1 AND task_short IS NULL",
      [shortLabel],
    );
  }
}

function nullIfEmpty(v: string): string | null {
  return v.length === 0 ? null : v;
}
