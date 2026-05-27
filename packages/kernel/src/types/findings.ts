// Finding — schema-validated review output recorded by reviewer /
// validator agents at ingest time. The TS shape mirrors the JSON
// Schema; the schema is the canonical validator at the IO boundary.

export type FindingSeverity = "blocking" | "warn" | "info";
export type FindingStatus = "open" | "fixed" | "accepted_by_human" | "dismissed";

export interface Finding {
  schema_version: string;
  id: string;
  agent: string;
  iteration: number;
  task_id: string;
  file: string | null;
  line_start: number | null;
  line_end: number | null;
  severity: FindingSeverity;
  category: string;
  proposed_new_category: string | null;
  pattern_id: string | null;
  summary: string;
  evidence_excerpt: string | null;
  suggested_fix: string | null;
  status: FindingStatus;
  ref_rule_id: string | null;
}
