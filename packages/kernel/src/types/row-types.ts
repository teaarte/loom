// Supporting row types that mirror SQLite tables and constitute the
// eager collections on the state snapshot.

import type { NowToken } from "./now.js";

// Phase is bundle-declared. Kernel treats the value as opaque.
export type Phase = string;

export type PhaseStatus = "pending" | "in_progress" | "completed" | "skipped";

export interface PhaseRow {
  name: Phase;
  status: PhaseStatus;
  skipped_reason: string | null;
  phase_extension: Record<string, unknown> | null;
  updated_at: string;
}

// Three kernel-recognized roles. Bundles extend the union via
// `Bundle.extends_vocab.gate_roles_extra`; the open-string branch keeps
// the type system permissive while runtime validation refuses
// unregistered values.
export type GateRole = "classify" | "plan" | "final" | (string & {});

export type GateStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "auto-approved"
  | "auto-rejected"
  | "skipped";

export type GateDecidedBy = "human" | "auto-policy";

export interface GateRow {
  name: string;
  status: GateStatus;
  decided_by: GateDecidedBy;
  feedback: string | null;
  decided_at: string | null;
}

export type AgentVerdictValue =
  | "APPROVE"
  | "REQUEST_CHANGES"
  | "PASS"
  | "FAIL"
  | "PASS_WITH_WARNINGS";

export interface AgentVerdictRow {
  phase: Phase;
  agent: string;
  iteration: number;
  verdict: AgentVerdictValue;
  summary_line: string | null;
  blocking_issues: number;
  warn_issues: number;
  info_issues: number;
  categories_seen: string[];
  recorded_at: string;
}

// Opaque to the kernel. Two recognized conventions at provider-resolution
// time: role tiers ("fast" / "balanced" / "premium" / open string) and
// concrete vendor identifiers. No vendor names appear in this type by
// design.
export type ModelName = string;

export interface PendingAgentRow {
  agent_run_id: string;
  agent: string;
  phase: Phase;
  model: ModelName | null;
  started_at: NowToken;
}

export interface StackInfo {
  language: string;
  package_manager: string | null;
  test_command: string | null;
  lint_command: string | null;
  build_command: string | null;
  project_type: "frontend-app" | "backend" | "library" | "monorepo" | null;
}
