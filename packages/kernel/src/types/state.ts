// PipelineState — the kernel-internal aggregate snapshot — plus its
// narrow read-only projection (`BundleStateView`) that bundle plugins
// actually see. Two projections, one source: the kernel narrows via
// `narrowStateForBundle(state, now)` at every plugin call site so
// bundle code never grows a dependency on FSM-driver internals.

import type { NowToken } from "./now.js";
import type { PolicyName } from "./policy.js";
import type {
  AgentVerdictRow,
  GateRole,
  GateRow,
  PendingAgentRow,
  PhaseRow,
} from "./row-types.js";

// The WORK signal, orthogonal to the orchestration `verdict`. `verdict`
// says how the orchestration ended; `work_result` says whether the work
// itself is clean. A task can be `failed_force_closed` (orchestration) yet
// `clean` (work) — green code that an operator force-closed past a stuck
// harness loop. Generic + domain-blind: `clean` ⇔ no open blocking CODE
// finding remains; `blocked` ⇔ at least one does; `unknown` ⇔ not yet
// evaluated (still in progress, or no terminal boundary reached).
export type WorkResult = "clean" | "blocked" | "unknown";

export interface PipelineState {
  schema_version: string;
  task_id: string | null;
  driver_state_id: string;
  project_dir: string;
  bundle: string;
  task: string;
  task_short: string | null;
  owner_id: string | null;
  status: "in_progress" | "completed" | "abandoned";
  verdict: "accepted" | "rejected" | "failed_force_closed" | null;
  // Orthogonal to `verdict`: the WORK signal (null until a terminal
  // boundary computes it). See `WorkResult`.
  work_result: WorkResult | null;
  started_at: NowToken;
  ended_at: NowToken | null;
  // Wire-form PolicyName strings — closures are resolved at call time
  // by the kernel dispatcher; keeping the snapshot pure-data makes it
  // trivially serializable and structurally comparable. Partial over
  // GateRole: only the roles a task overrides are present (the operator-
  // override tier); the dispatcher falls through to the bundle default
  // and then the kernel baseline for any role not named here.
  gate_policies: Partial<Record<GateRole, PolicyName>>;
  decisions: Record<string, unknown>;
  bundle_state: Record<string, unknown> | null;
  pipeline_violation: string | null;
  force_used: boolean;
  agents_count: number;
  // Partial over GateRole: counters exist only for roles that have been
  // gated at least once (rows are created lazily per role).
  gate_revisions: Partial<Record<GateRole, number>>;
  gate_auto_rejections: Partial<Record<GateRole, number>>;
  files_created: string[];
  files_modified: string[];
  total_tokens_in: number;
  total_tokens_out: number;
  total_tokens_cached: number;

  // FSM-internal driver row. Stripped before bundle plugins see state.
  driver: {
    flow_name: string;
    step_index: number;
    complete: boolean;
    // Set when a human-required gate parks the tick. Carries the
    // gate_event_id the ask was issued under so the matching user-answer
    // delivery can be bound to this exact gate event (a mismatched id is
    // refused as stale).
    pending_user_answer: {
      gate: string;
      message: string;
      gate_event_id: string;
    } | null;
    scratch: Record<string, unknown>;
  };

  phases: PhaseRow[];
  gates: Record<string, GateRow>;
  agent_verdicts: AgentVerdictRow[];
  pending_agents: PendingAgentRow[];

  now: NowToken;
}

// Narrow read-only projection. Hides driver.* and schema_version so
// bundle code cannot grow accidental dependencies on FSM internals.
export interface BundleStateView {
  task_id: string | null;
  driver_state_id: string;
  project_dir: string;
  bundle: string;
  task: string;
  task_short: string | null;
  owner_id: string | null;
  status: "in_progress" | "completed" | "abandoned";
  verdict: "accepted" | "rejected" | "failed_force_closed" | null;
  started_at: NowToken;
  ended_at: NowToken | null;
  gate_policies: Partial<Record<GateRole, PolicyName>>;
  decisions: Record<string, unknown>;
  bundle_state: Record<string, unknown> | null;
  pipeline_violation: string | null;
  force_used: boolean;
  agents_count: number;
  gate_revisions: Partial<Record<GateRole, number>>;
  gate_auto_rejections: Partial<Record<GateRole, number>>;
  files_created: string[];
  files_modified: string[];
  total_tokens_in: number;
  total_tokens_out: number;
  total_tokens_cached: number;
  phases: PhaseRow[];
  gates: Record<string, GateRow>;
  agent_verdicts: AgentVerdictRow[];
  pending_agents: PendingAgentRow[];
  now: NowToken;
}

// Returned by pipeline_state_get — shape varies by `format` param.
export type PipelineStateView =
  | { format: "summary"; summary: Record<string, unknown> }
  | { format: "json"; state: PipelineState }
  | { format: "jsonl"; lines: string[] }
  | { format: "pretty-table"; tables: Record<string, string> };
