// The per-task agent-chain reader — a transport-side, DOMAIN-BLIND projection of
// what a task's store recorded: the ordered chain of agent runs, their token
// counts and persist timestamps, the structured findings/verdicts/gates the
// review stages produced, and the canonical task bookends. It is the read peer
// of `readState` (which returns the live FSM projection); where `readState`
// answers "where is the task now", this answers "what ran, in what order, and
// what did each produce".
//
// Two entry points share ONE reader so the live and archived paths can never
// drift: `readTrace(projectDir)` reads the live `<dir>/.loom/state.db` through
// the kernel pool exactly as `readState` does; `readTraceFile(dbPath)` opens an
// arbitrary archived store (`<dir>/.loom/history/<task_id>.db`, the same
// schema rotated aside on finish) read-only and reads it with the same SELECTs.
// A finished task is therefore inspectable exactly like the active one.
//
// Domain-blind by construction: it reads only generic FSM columns — the agent
// NAME is data, never branched on; it never touches the bundle's `bundle_state`,
// its detected toolchain, or its decisions map. Every name a caller renders came
// off the store as a value.
//
// Ambient I/O / clock are fine here — this is transport runtime OUTSIDE the
// kernel's replay graph, the same posture `readState` and the read-model take.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { captureNow, openDb, projectFootprintDir, TransactionImpl, type Transaction } from "@loomfsm/kernel";

// One recorded agent run — the `agent_records` row, narrowed to the fields a
// reader renders. `agent` / `output_kind` are opaque DATA.
export interface TraceAgent {
  agent_run_id: string;
  agent: string;
  phase: string;
  model: string | null;
  output_kind: string;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cached: number | null;
  // ISO-8601 of when the run's result was persisted (end-of-spawn). Per-agent
  // DURATION is DERIVED transport-side from the deltas between these (and the
  // task's `started_at` for the first) — exact per-spawn timing is not stored.
  recorded_at: string;
}

// One structured review finding — the `findings` row, narrowed for display.
export interface TraceFinding {
  id: string;
  agent: string;
  phase: string;
  iteration: number;
  file: string | null;
  line_start: number | null;
  line_end: number | null;
  severity: string;
  category: string;
  summary: string;
  status: string;
  recorded_at: string;
}

// One reviewer/validator verdict — the `agent_verdicts` row.
export interface TraceVerdict {
  phase: string;
  agent: string;
  iteration: number;
  verdict: string;
  summary_line: string | null;
  blocking_issues: number;
  warn_issues: number;
  info_issues: number;
  recorded_at: string;
}

// One gate decision — the `gates` row. The gate NAME is bundle-declared data.
export interface TraceGate {
  name: string;
  status: string;
  decided_by: string;
  feedback: string | null;
  decided_at: string | null;
}

// The canonical task bookends — `pipeline_state`, read for the chain header and
// the derived-duration anchor. Deliberately excludes the bundle's `bundle_state`
// / decisions / detected toolchain: the chain reader stays domain-blind.
export interface TraceSummary {
  task_id: string | null;
  status: string | null;
  verdict: string | null;
  started_at: string | null;
  ended_at: string | null;
  task: string | null;
  // The bundle-supplied completion note the kernel appends to the terminal
  // summary (a plain string in `bundle_state.completion_summary`). Read here the
  // SAME way the kernel's finalize reads it — a generic surfaced field, never
  // branched on — so the dashboard can show "what was done" on a completed /
  // archived task. Null when none was written / the task has not finished.
  completion_summary: string | null;
}

// Store-native token totals — summed across every recorded agent run. The
// kernel persists neutral in/out/cached per spawn (NOT dollars, NOT cache-write,
// which are driver-side observability), so the read-model can roll up exactly
// those three. The authoritative cost + cache-write total rides on the drive
// outcome / the per-spawn transcript usage, not the store.
export interface TraceTokenTotals {
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
}

export interface TraceView {
  // Null when the store carries no canonical task row (a never-run / archived-out
  // slot) — the reader degrades to "nothing recorded" rather than throwing.
  summary: TraceSummary | null;
  agents: TraceAgent[];
  findings: TraceFinding[];
  verdicts: TraceVerdict[];
  gates: TraceGate[];
  // Token totals summed across `agents` (store-native; cost/cache-write are not
  // stored — see `TraceTokenTotals`). Zeroed when nothing ran.
  token_totals: TraceTokenTotals;
}

const EMPTY_TRACE: TraceView = {
  summary: null,
  agents: [],
  findings: [],
  verdicts: [],
  gates: [],
  token_totals: { tokens_in: 0, tokens_out: 0, tokens_cached: 0 },
};

function stateDbPath(projectDir: string): string {
  return join(projectFootprintDir(projectDir), "state.db");
}

// Read the live store's trace. Mirrors `readState`: it borrows the project's
// pooled (already-migrated) connection and reads with no write transaction. A
// project with no live store yet reads as the empty trace — and crucially does
// NOT create one (no `openDb`, which would construct + migrate a fresh store on
// a mere read).
export async function readTrace(projectDir: string): Promise<TraceView> {
  if (!existsSync(stateDbPath(projectDir))) return EMPTY_TRACE;
  const db = openDb(projectDir);
  const tx = new TransactionImpl(db, captureNow());
  return await readTraceFromTx(tx);
}

// Read an arbitrary on-disk store file (an archived `<task_id>.db`) with the SAME
// reader. Opened query-only and closed straight after — never pooled, never
// migrated; the archived snapshot already carries the schema it was rotated with.
export async function readTraceFile(dbPath: string): Promise<TraceView> {
  if (!existsSync(dbPath)) return EMPTY_TRACE;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA query_only = ON");
    const tx = new TransactionImpl(db, captureNow());
    return await readTraceFromTx(tx);
  } finally {
    db.close();
  }
}

// ----- shared reader -----------------------------------------------------

interface SummaryRow {
  task_id: unknown;
  status: unknown;
  verdict: unknown;
  started_at: unknown;
  ended_at: unknown;
  task: unknown;
  bundle_state: unknown;
}
interface AgentRow {
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
interface FindingRow {
  id: unknown;
  agent: unknown;
  phase: unknown;
  iteration: unknown;
  file: unknown;
  line_start: unknown;
  line_end: unknown;
  severity: unknown;
  category: unknown;
  summary: unknown;
  status: unknown;
  recorded_at: unknown;
}
interface VerdictRow {
  phase: unknown;
  agent: unknown;
  iteration: unknown;
  verdict: unknown;
  summary_line: unknown;
  blocking_issues: unknown;
  warn_issues: unknown;
  info_issues: unknown;
  recorded_at: unknown;
}
interface GateRow {
  name: unknown;
  status: unknown;
  decided_by: unknown;
  feedback: unknown;
  decided_at: unknown;
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

// Extract the kernel-surfaced `completion_summary` string from the stored
// `bundle_state` JSON. This is the ONE field of `bundle_state` the reader looks
// at — the same generic completion note the kernel's finalize appends — so the
// reader stays domain-blind (it reads a plain string, names no agent / flow /
// finding). Anything else in `bundle_state` is left untouched. Null-safe on a
// missing column / non-object / non-string field.
function completionSummaryOf(bundleState: unknown): string | null {
  if (typeof bundleState !== "string" || bundleState.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bundleState);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const note = (parsed as Record<string, unknown>)["completion_summary"];
  return typeof note === "string" && note.length > 0 ? note : null;
}

async function readTraceFromTx(tx: Transaction): Promise<TraceView> {
  const summaryRow = await tx.queryRow<SummaryRow>(
    "SELECT task_id, status, verdict, started_at, ended_at, task, bundle_state FROM pipeline_state WHERE id = 1",
  );
  const summary: TraceSummary | null =
    summaryRow === null
      ? null
      : {
          task_id: str(summaryRow.task_id),
          status: str(summaryRow.status),
          verdict: str(summaryRow.verdict),
          started_at: str(summaryRow.started_at),
          ended_at: str(summaryRow.ended_at),
          task: str(summaryRow.task),
          completion_summary: completionSummaryOf(summaryRow.bundle_state),
        };

  const agentRows = await tx.queryAll<AgentRow>(
    "SELECT agent_run_id, agent, phase, model, output_kind, tokens_in, tokens_out, " +
      "tokens_cached, recorded_at FROM agent_records ORDER BY id ASC",
  );
  const agents: TraceAgent[] = agentRows.map((r) => ({
    agent_run_id: String(r.agent_run_id),
    agent: String(r.agent),
    phase: String(r.phase),
    model: str(r.model),
    output_kind: String(r.output_kind),
    tokens_in: num(r.tokens_in),
    tokens_out: num(r.tokens_out),
    tokens_cached: num(r.tokens_cached),
    recorded_at: String(r.recorded_at),
  }));

  const findingRows = await tx.queryAll<FindingRow>(
    "SELECT id, agent, phase, iteration, file, line_start, line_end, severity, " +
      "category, summary, status, recorded_at FROM findings ORDER BY id ASC",
  );
  const findings: TraceFinding[] = findingRows.map((r) => ({
    id: String(r.id),
    agent: String(r.agent),
    phase: String(r.phase),
    iteration: Number(r.iteration),
    file: str(r.file),
    line_start: num(r.line_start),
    line_end: num(r.line_end),
    severity: String(r.severity),
    category: String(r.category),
    summary: String(r.summary),
    status: String(r.status),
    recorded_at: String(r.recorded_at),
  }));

  const verdictRows = await tx.queryAll<VerdictRow>(
    "SELECT phase, agent, iteration, verdict, summary_line, blocking_issues, " +
      "warn_issues, info_issues, recorded_at FROM agent_verdicts ORDER BY id ASC",
  );
  const verdicts: TraceVerdict[] = verdictRows.map((r) => ({
    phase: String(r.phase),
    agent: String(r.agent),
    iteration: Number(r.iteration),
    verdict: String(r.verdict),
    summary_line: str(r.summary_line),
    blocking_issues: Number(r.blocking_issues),
    warn_issues: Number(r.warn_issues),
    info_issues: Number(r.info_issues),
    recorded_at: String(r.recorded_at),
  }));

  const gateRows = await tx.queryAll<GateRow>(
    "SELECT name, status, decided_by, feedback, decided_at FROM gates ORDER BY decided_at ASC, name ASC",
  );
  const gates: TraceGate[] = gateRows.map((r) => ({
    name: String(r.name),
    status: String(r.status),
    decided_by: String(r.decided_by),
    feedback: str(r.feedback),
    decided_at: str(r.decided_at),
  }));

  // Roll up the store-native per-spawn token counts into a task total so a
  // read-model surface (the dashboard) shows whole-task tokens without summing
  // every row itself.
  const token_totals: TraceTokenTotals = { tokens_in: 0, tokens_out: 0, tokens_cached: 0 };
  for (const a of agents) {
    token_totals.tokens_in += a.tokens_in ?? 0;
    token_totals.tokens_out += a.tokens_out ?? 0;
    token_totals.tokens_cached += a.tokens_cached ?? 0;
  }

  return { summary, agents, findings, verdicts, gates, token_totals };
}
