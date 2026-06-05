// Shared SQLite row → typed-shape mappers for the tables read from more than
// one place.
//
// The kernel reads `agent_records` and `kernel_idempotency_ledger` rows in two
// call sites each (the invariant loader + the per-tick access snapshot;
// the invariant loader + the ledger reader). Each pair was a byte-identical
// column list and field-construction block kept in sync by hand — exactly the
// silent-drift trap: ADD a column to one SELECT and forget the other and the
// two reads quietly disagree. Hoisting the mapping here makes the column set
// and the shape one definition, so a schema change is a one-line edit with a
// type error if a consumer's expectation drifts.
//
// Behaviour-preserving: the field construction is the union of the prior two
// copies (the `null`-coalescing, the `Number`/`String` coercions). No clock,
// no I/O — pure row → object.

import type { AgentRecord } from "../types/agent-result.js";
import type { IdempotencyKey, IdempotencyLedgerEntry } from "../types/idempotency.js";

// The raw `agent_records` columns this mapper consumes, in SELECT order.
export const AGENT_RECORD_COLUMNS =
  "id, agent_run_id, agent, phase, model, output_kind, " +
  "tokens_in, tokens_out, tokens_cached, recorded_at";

export interface AgentRecordRow {
  id: unknown;
  agent_run_id: unknown;
  agent: unknown;
  phase: unknown;
  model: unknown;
  output_kind: unknown;
  tokens_in: unknown;
  tokens_out: unknown;
  tokens_cached: unknown;
  recorded_at: unknown;
}

export function mapAgentRecord(r: AgentRecordRow): AgentRecord {
  return {
    id: Number(r.id),
    agent_run_id: String(r.agent_run_id),
    agent: String(r.agent),
    phase: String(r.phase) as AgentRecord["phase"],
    model: r.model === null ? null : String(r.model),
    output_kind: String(r.output_kind) as AgentRecord["output_kind"],
    tokens_in: r.tokens_in === null ? null : Number(r.tokens_in),
    tokens_out: r.tokens_out === null ? null : Number(r.tokens_out),
    tokens_cached: r.tokens_cached === null ? null : Number(r.tokens_cached),
    recorded_at: String(r.recorded_at),
  };
}

// The raw `kernel_idempotency_ledger` columns this mapper consumes, in SELECT
// order. Callers add their own WHERE / ORDER BY tail.
export const LEDGER_COLUMNS =
  "key, first_seen_ts, last_seen_ts, response_blob, hook_results_json";

export interface LedgerRow {
  key: unknown;
  first_seen_ts: unknown;
  last_seen_ts: unknown;
  response_blob: unknown;
  hook_results_json: unknown;
}

export function mapLedgerRow(r: LedgerRow): IdempotencyLedgerEntry {
  return {
    key: String(r.key) as IdempotencyKey,
    first_seen_ts: String(r.first_seen_ts),
    last_seen_ts: String(r.last_seen_ts),
    response_blob: r.response_blob === null ? null : String(r.response_blob),
    hook_results_json: r.hook_results_json === null ? null : String(r.hook_results_json),
  };
}
