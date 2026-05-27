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
  StackInfo,
} from "./row-types.js";

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
  started_at: NowToken;
  ended_at: NowToken | null;
  // Wire-form PolicyName strings — closures are resolved at call time
  // by the kernel dispatcher; keeping the snapshot pure-data makes it
  // trivially serializable and structurally comparable.
  gate_policies: Record<GateRole, PolicyName>;
  decisions: Record<string, unknown>;
  bundle_state: Record<string, unknown> | null;
  stack: StackInfo | null;
  pipeline_violation: string | null;
  force_used: boolean;
  agents_count: number;
  gate_revisions: Record<GateRole, number>;
  gate_auto_rejections: Record<GateRole, number>;
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
    pending_user_answer: { gate: string; message: string } | null;
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
  gate_policies: Record<GateRole, PolicyName>;
  decisions: Record<string, unknown>;
  bundle_state: Record<string, unknown> | null;
  stack: StackInfo | null;
  pipeline_violation: string | null;
  force_used: boolean;
  agents_count: number;
  gate_revisions: Record<GateRole, number>;
  gate_auto_rejections: Record<GateRole, number>;
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

export declare function narrowStateForBundle(
  state: PipelineState,
  now: NowToken,
): BundleStateView;

// Returned by pipeline_state_get — shape varies by `format` param.
export type PipelineStateView =
  | { format: "summary"; summary: Record<string, unknown> }
  | { format: "json"; state: PipelineState }
  | { format: "jsonl"; lines: string[] }
  | { format: "pretty-table"; tables: Record<string, string> };
