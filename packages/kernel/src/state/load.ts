// Snapshot materializer — read the canonical row + eager collections
// inside the caller's open tx and return a fully-typed PipelineState.
//
// Heavy collections (findings, agent_records, audit) are NOT loaded
// here — they flow through context-side lazy accessors so a snapshot
// stays cheap to materialize for callers that only need the aggregate.

import type { NowToken } from "../types/now.js";
import type { PolicyName } from "../types/policy.js";
import type {
  AgentVerdictRow,
  AgentVerdictValue,
  GateRole,
  GateRow,
  PendingAgentRow,
  PhaseRow,
  PhaseStatus,
  StackInfo,
} from "../types/row-types.js";
import type { PipelineState } from "../types/state.js";
import type { Transaction } from "../types/transaction.js";
import { KernelError } from "./db.js";
import { parseStateJson as parseJsonField } from "./json.js";

// Materialize the typed PipelineState from rows in the open tx.
//
// Throws STATE_NOT_INITIALIZED when called before the task-create tx
// has inserted the canonical pipeline_state / driver_state rows.
// Throws STATE_CORRUPT when a JSON column on disk fails to parse —
// the on-disk CHECK should have refused the write, so reaching this
// branch means external tampering or a backend-skew bug.
export async function loadState(tx: Transaction): Promise<PipelineState> {
  const ps = await tx.queryRow<PipelineStateRow>(
    "SELECT * FROM pipeline_state WHERE id = 1",
  );
  if (ps === null) {
    throw new KernelError({
      code: "STATE_NOT_INITIALIZED",
      message: "pipeline_state row missing",
    });
  }

  const driver = await tx.queryRow<DriverStateRow>(
    "SELECT * FROM driver_state WHERE id = 1",
  );
  if (driver === null) {
    throw new KernelError({
      code: "STATE_NOT_INITIALIZED",
      message: "driver_state row missing",
    });
  }

  const counters =
    (await tx.queryRow<CountersRow>(
      "SELECT * FROM pipeline_counters WHERE id = 1",
    )) ?? {
      id: 1,
      agents_count: 0,
      total_tokens_in: 0,
      total_tokens_out: 0,
      total_tokens_cached: 0,
    };

  const gateCounters = await tx.queryAll<GateCountersRow>(
    "SELECT role, human_revisions, auto_rejections FROM pipeline_gate_counters",
  );

  const phaseRows = await tx.queryAll<PhaseRowRaw>(
    "SELECT name, status, skipped_reason, phase_extension, updated_at FROM phases",
  );

  const gateRows = await tx.queryAll<GateRowRaw>(
    "SELECT name, status, decided_by, feedback, decided_at FROM gates",
  );

  const verdictRows = await tx.queryAll<VerdictRowRaw>(
    "SELECT phase, agent, iteration, verdict, summary_line, " +
      "blocking_issues, warn_issues, info_issues, categories_seen, recorded_at " +
      "FROM agent_verdicts ORDER BY id ASC",
  );

  const pendingRows = await tx.queryAll<PendingRowRaw>(
    "SELECT agent_run_id, agent, phase, model, started_at FROM pending_agents",
  );

  // The TS type uses Record<GateRole, number> where GateRole carries
  // three kernel-shipped literal roles plus an open string branch;
  // populating only the rows present on disk is the correct shape,
  // so we build the maps as Record<string, ...> and cast at the boundary.
  const gateRevisionsBuilder: Record<string, number> = {};
  const gateAutoRejectionsBuilder: Record<string, number> = {};
  for (const row of gateCounters) {
    gateRevisionsBuilder[row.role] = Number(row.human_revisions);
    gateAutoRejectionsBuilder[row.role] = Number(row.auto_rejections);
  }
  const gate_revisions = gateRevisionsBuilder as Record<GateRole, number>;
  const gate_auto_rejections = gateAutoRejectionsBuilder as Record<GateRole, number>;

  const phases: PhaseRow[] = phaseRows.map((r) => ({
    name: String(r.name),
    status: r.status as PhaseStatus,
    skipped_reason: r.skipped_reason === null ? null : String(r.skipped_reason),
    phase_extension: parseJsonField(r.phase_extension, null),
    updated_at: String(r.updated_at),
  }));

  const gates: Record<string, GateRow> = {};
  for (const r of gateRows) {
    gates[String(r.name)] = {
      name: String(r.name),
      status: r.status as GateRow["status"],
      decided_by: r.decided_by as GateRow["decided_by"],
      feedback: r.feedback === null ? null : String(r.feedback),
      decided_at: r.decided_at === null ? null : String(r.decided_at),
    };
  }

  const agent_verdicts: AgentVerdictRow[] = verdictRows.map((r) => ({
    phase: String(r.phase),
    agent: String(r.agent),
    iteration: Number(r.iteration),
    verdict: r.verdict as AgentVerdictValue,
    summary_line: r.summary_line === null ? null : String(r.summary_line),
    blocking_issues: Number(r.blocking_issues),
    warn_issues: Number(r.warn_issues),
    info_issues: Number(r.info_issues),
    categories_seen: parseJsonField<string[]>(r.categories_seen, []),
    recorded_at: String(r.recorded_at),
  }));

  const pending_agents: PendingAgentRow[] = pendingRows.map((r) => ({
    agent_run_id: String(r.agent_run_id),
    agent: String(r.agent),
    phase: String(r.phase),
    model: r.model === null ? null : String(r.model),
    started_at: String(r.started_at) as NowToken,
  }));

  return {
    schema_version: String(ps.schema_version),
    task_id: ps.task_id === null ? null : String(ps.task_id),
    driver_state_id: String(ps.driver_state_id),
    project_dir: String(ps.project_dir),
    bundle: String(ps.bundle),
    task: String(ps.task),
    task_short: ps.task_short === null ? null : String(ps.task_short),
    owner_id: ps.owner_id === null ? null : String(ps.owner_id),
    status: ps.status as PipelineState["status"],
    verdict: ps.verdict === null ? null : (ps.verdict as PipelineState["verdict"]),
    started_at: String(ps.started_at) as NowToken,
    ended_at: ps.ended_at === null ? null : (String(ps.ended_at) as NowToken),
    gate_policies: parseJsonField<Record<string, PolicyName>>(
      ps.gate_policies,
      {},
    ) as Record<GateRole, PolicyName>,
    decisions: parseJsonField<Record<string, unknown>>(ps.decisions, {}),
    bundle_state: parseJsonField<Record<string, unknown> | null>(ps.bundle_state, null),
    stack: parseJsonField<StackInfo | null>(ps.stack, null),
    pipeline_violation:
      ps.pipeline_violation === null ? null : String(ps.pipeline_violation),
    force_used: Number(ps.force_used) !== 0,
    agents_count: Number(counters.agents_count),
    gate_revisions,
    gate_auto_rejections,
    files_created: parseJsonField<string[]>(ps.files_created, []),
    files_modified: parseJsonField<string[]>(ps.files_modified, []),
    total_tokens_in: Number(counters.total_tokens_in),
    total_tokens_out: Number(counters.total_tokens_out),
    total_tokens_cached: Number(counters.total_tokens_cached),
    driver: {
      flow_name: String(driver.flow_name),
      step_index: Number(driver.step_index),
      complete: Number(driver.complete) !== 0,
      pending_user_answer: parseJsonField<
        { gate: string; message: string; gate_event_id: string } | null
      >(driver.pending_user_answer, null),
      scratch: parseJsonField<Record<string, unknown>>(driver.scratch, {}),
    },
    phases,
    gates,
    agent_verdicts,
    pending_agents,
    now: tx.now,
  };
}

// ============================================================================
// Row types — kernel-internal shapes returned by the SELECTs above.
// ============================================================================

interface PipelineStateRow {
  id: number;
  schema_version: unknown;
  project_dir: unknown;
  bundle: unknown;
  task_id: unknown;
  task: unknown;
  task_short: unknown;
  driver_state_id: unknown;
  owner_id: unknown;
  status: unknown;
  verdict: unknown;
  started_at: unknown;
  ended_at: unknown;
  gate_policies: unknown;
  decisions: unknown;
  bundle_state: unknown;
  files_created: unknown;
  files_modified: unknown;
  stack: unknown;
  pipeline_violation: unknown;
  force_used: unknown;
}

interface DriverStateRow {
  flow_name: unknown;
  step_index: unknown;
  complete: unknown;
  pending_user_answer: unknown;
  scratch: unknown;
}

interface CountersRow {
  id: number;
  agents_count: unknown;
  total_tokens_in: unknown;
  total_tokens_out: unknown;
  total_tokens_cached: unknown;
}

interface GateCountersRow {
  role: string;
  human_revisions: unknown;
  auto_rejections: unknown;
}

interface PhaseRowRaw {
  name: unknown;
  status: unknown;
  skipped_reason: unknown;
  phase_extension: unknown;
  updated_at: unknown;
}

interface GateRowRaw {
  name: unknown;
  status: unknown;
  decided_by: unknown;
  feedback: unknown;
  decided_at: unknown;
}

interface VerdictRowRaw {
  phase: unknown;
  agent: unknown;
  iteration: unknown;
  verdict: unknown;
  summary_line: unknown;
  blocking_issues: unknown;
  warn_issues: unknown;
  info_issues: unknown;
  categories_seen: unknown;
  recorded_at: unknown;
}

interface PendingRowRaw {
  agent_run_id: unknown;
  agent: unknown;
  phase: unknown;
  model: unknown;
  started_at: unknown;
}
