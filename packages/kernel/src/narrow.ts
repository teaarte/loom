// Bundle-facing read-only projection.
//
// Strips the FSM-driver branch (`driver.*`) and `schema_version` from
// `PipelineState` so bundle plugins (policies, invariants, hooks,
// stages) cannot grow accidental dependencies on kernel-internal
// working set. `now` is threaded in from the FSM tick boundary; it is
// identical to `state.now` (the snapshot's recorded value), but
// declared as a parameter so the projection always reflects the
// tick's captured `NowToken` even on paths that re-derive state from
// a stored row.
//
// `Object.freeze` on the top level gives a runtime tripwire against
// accidental mutation by bundle code. Deep-freezing collections is
// intentionally omitted — the TypeScript surface (read-only
// projection interface) makes mutation a compile-time error, and the
// kernel collections are large enough that a deep freeze would be a
// measurable per-tick cost.

import type { NowToken } from "./types/now.js";
import type { BundleStateView, PipelineState } from "./types/state.js";

export function narrowStateForBundle(
  state: PipelineState,
  now: NowToken,
): BundleStateView {
  return Object.freeze({
    task_id: state.task_id,
    driver_state_id: state.driver_state_id,
    project_dir: state.project_dir,
    bundle: state.bundle,
    task: state.task,
    task_short: state.task_short,
    owner_id: state.owner_id,
    status: state.status,
    verdict: state.verdict,
    started_at: state.started_at,
    ended_at: state.ended_at,
    gate_policies: state.gate_policies,
    decisions: state.decisions,
    bundle_state: state.bundle_state,
    pipeline_violation: state.pipeline_violation,
    force_used: state.force_used,
    agents_count: state.agents_count,
    gate_revisions: state.gate_revisions,
    gate_auto_rejections: state.gate_auto_rejections,
    files_created: state.files_created,
    files_modified: state.files_modified,
    total_tokens_in: state.total_tokens_in,
    total_tokens_out: state.total_tokens_out,
    total_tokens_cached: state.total_tokens_cached,
    phases: state.phases,
    gates: state.gates,
    agent_verdicts: state.agent_verdicts,
    pending_agents: state.pending_agents,
    now,
  });
}
