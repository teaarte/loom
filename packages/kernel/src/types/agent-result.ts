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
  schema_validation: { ok: true } | { ok: false; reason: string };
  tokens?: { in: number; out: number; cached?: number };
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
