// Finding — schema-validated review output recorded by reviewer /
// validator agents at ingest time. The TS shape mirrors the JSON
// Schema; the schema is the canonical validator at the IO boundary.

export type FindingSeverity = "blocking" | "warn" | "info";
export type FindingStatus = "open" | "fixed" | "accepted_by_human" | "dismissed";

// Provenance of a finding, independent of its severity. `code` is a fact
// ABOUT the work under review — a fixer can act on it. `harness` is a
// failure of the orchestration plumbing itself (an agent output that could
// not be parsed, a transport/tooling fault) — re-running the implementer
// cannot resolve it, so a gate routes it to a human rather than the rework
// loop. Kernel-determined provenance: agents report `code` findings about
// the work; the kernel mints the `harness` ones. Absent on a value ⇒ `code`
// (the column defaults to it).
export type FindingOrigin = "code" | "harness";

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
  // Absent ⇒ "code". Only the kernel mints "harness".
  origin?: FindingOrigin;
}
