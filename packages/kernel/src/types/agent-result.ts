// Agent run artifacts.
//
// `AgentResult` is what an agent's output decodes to once the kernel
// has parsed the JSON header (if any), extracted findings (for
// reviewer / validator output kinds), and run schema validation.
// `AgentRecord` is the persisted row — one per spawn that has
// returned. Any field added to AgentRecord must also be added to the
// `agent_records` SQL table (and vice versa).

import type { Finding } from "./findings.js";
import type { AgentOutputKind } from "./plugins.js";
import type { Phase } from "./row-types.js";

export interface AgentResult {
  agent: string;
  agent_run_id: string;
  output: string;
  parsed_header?: Record<string, unknown>;
  findings?: Finding[];
  schema_validation:
    | { ok: true }
    | { ok: false; reason: string; detail?: SchemaValidationDetail };
  tokens?: { in: number; out: number; cached?: number };
}

// Machine-readable shape of a parse / schema failure. `reason` stays the
// human one-liner every prior reader used; `detail` is the structured
// companion a driver (or an operator) reads to know WHAT to fix instead of
// guessing the envelope. The three kinds separate the failure modes that
// the old single `no-json-fence` label collapsed: nothing JSON-shaped was
// present at all (`no-json`), a candidate block was found but did not parse
// (`json-parse`), or it parsed but a required field was missing / ill-typed
// (`schema-field`).
export type SchemaValidationFailureKind = "no-json" | "json-parse" | "schema-field";

export interface SchemaValidationDetail {
  kind: SchemaValidationFailureKind;
  // The offending field (schema-field failures) — e.g. "verdict",
  // "findings", "findings[0].severity".
  field?: string;
  // Human-readable expectation, e.g. "a non-empty string".
  expected?: string;
  // What was actually seen, e.g. "array", "undefined", "number".
  got?: string;
  // Bounded slice of the raw output for forensics — never the whole blob.
  excerpt?: string;
}

export interface BatchAgentResult {
  results: AgentResult[];
  parse_errors: ParseError[];
}

export interface ParseError {
  agent_run_id: string;
  agent: string;
  reason: string;
}

export interface AgentRecord {
  id: number;
  agent_run_id: string;
  agent: string;
  phase: Phase;
  model: string | null;
  output_kind: AgentOutputKind;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cached: number | null;
  recorded_at: string;
}
