// Pre-materialized per-tick query surfaces.
//
// `materializeAccessSnapshot(tx)` runs three SELECTs once at the
// start of a stage tick (findings ASC, audit DESC LIMIT 200, agent
// records ASC) and wraps the results in sync access impls. The
// policy hot path (`on-blockers` and bundle-shipped factories) reads
// `ctx.findings.countBlocking(...)` as a sync call; serving that
// from a per-call SELECT would force an async surface through every
// policy call site. Pre-materialization trades three SELECTs per
// tick for sync ergonomics across the rest of the kernel.
//
// `emptyFindingsAccess` / `emptyAuditAccess` / `emptyAgentRecordsAccess`
// short-circuit the SELECTs when a caller knows no read is needed
// (the HookContext path skips materialization when no hooks are
// registered).

import type { AgentRecord } from "../types/agent-result.js";
import type {
  AgentRecordsAccess,
  AuditAccess,
  FindingsAccess,
} from "../types/context.js";
import type { Finding } from "../types/findings.js";
import type { AuditEntry, Transaction } from "../types/transaction.js";

export interface AccessSnapshot {
  findings: FindingsAccess;
  audit_query: AuditAccess;
  agents_query: AgentRecordsAccess;
}

export async function materializeAccessSnapshot(
  tx: Transaction,
): Promise<AccessSnapshot> {
  const findingsRows = await tx.queryAll<FindingRow>(
    "SELECT id, task_id, agent, iteration, phase, file, line_start, " +
      "line_end, severity, category, proposed_new_category, pattern_id, " +
      "summary, evidence_excerpt, suggested_fix, status, ref_rule_id, " +
      "recorded_at FROM findings ORDER BY id ASC",
  );
  const auditRows = await tx.queryAll<AuditRow>(
    "SELECT id, ts, type, task_id, driver_state_id, payload, verdict, " +
      "error_class FROM audit ORDER BY id DESC LIMIT 200",
  );
  const agentRows = await tx.queryAll<AgentRecordRow>(
    "SELECT id, agent_run_id, agent, phase, model, output_kind, " +
      "tokens_in, tokens_out, tokens_cached, recorded_at " +
      "FROM agent_records ORDER BY id ASC",
  );

  const stored: StoredFinding[] = findingsRows.map((r) => ({
    phase: String(r.phase),
    finding: {
      schema_version: "",
      id: String(r.id),
      agent: String(r.agent),
      iteration: Number(r.iteration),
      task_id: r.task_id === null ? "" : String(r.task_id),
      file: r.file === null ? null : String(r.file),
      line_start: r.line_start === null ? null : Number(r.line_start),
      line_end: r.line_end === null ? null : Number(r.line_end),
      severity: r.severity as Finding["severity"],
      category: String(r.category),
      proposed_new_category:
        r.proposed_new_category === null ? null : String(r.proposed_new_category),
      pattern_id: r.pattern_id === null ? null : String(r.pattern_id),
      summary: String(r.summary),
      evidence_excerpt:
        r.evidence_excerpt === null ? null : String(r.evidence_excerpt),
      suggested_fix:
        r.suggested_fix === null ? null : String(r.suggested_fix),
      status: r.status as Finding["status"],
      ref_rule_id: r.ref_rule_id === null ? null : String(r.ref_rule_id),
    },
  }));

  const audit: AuditEntry[] = auditRows.map((r) => ({
    id: Number(r.id),
    ts: String(r.ts),
    type: String(r.type),
    task_id: r.task_id === null ? null : String(r.task_id),
    driver_state_id: r.driver_state_id === null ? null : String(r.driver_state_id),
    payload: parseJsonObject(r.payload),
    verdict: r.verdict as AuditEntry["verdict"],
    error_class: r.error_class === null ? null : String(r.error_class),
  }));

  const agents: AgentRecord[] = agentRows.map((r) => ({
    id: Number(r.id),
    agent_run_id: String(r.agent_run_id),
    agent: String(r.agent),
    phase: String(r.phase),
    model: r.model === null ? null : String(r.model),
    output_kind: String(r.output_kind) as AgentRecord["output_kind"],
    tokens_in: r.tokens_in === null ? null : Number(r.tokens_in),
    tokens_out: r.tokens_out === null ? null : Number(r.tokens_out),
    tokens_cached: r.tokens_cached === null ? null : Number(r.tokens_cached),
    recorded_at: String(r.recorded_at),
  }));

  return {
    findings: buildFindingsAccess(stored),
    audit_query: buildAuditAccess(audit),
    agents_query: buildAgentRecordsAccess(agents),
  };
}

export function emptyFindingsAccess(): FindingsAccess {
  return {
    query: () => [],
    countBlocking: () => 0,
    queryByPhase: () => [],
  };
}

export function emptyAuditAccess(): AuditAccess {
  return { recent: () => [] };
}

export function emptyAgentRecordsAccess(): AgentRecordsAccess {
  return { query: () => [] };
}

// ============================================================================
// Internal builders + row shapes
// ============================================================================

interface StoredFinding {
  finding: Finding;
  phase: string;
}

function buildFindingsAccess(stored: StoredFinding[]): FindingsAccess {
  return {
    query(filter) {
      return stored
        .filter((sf) => {
          if (filter.phase !== undefined && sf.phase !== filter.phase) return false;
          if (filter.agent !== undefined && sf.finding.agent !== filter.agent) return false;
          if (
            filter.severity !== undefined &&
            !filter.severity.includes(sf.finding.severity)
          ) {
            return false;
          }
          if (
            filter.status !== undefined &&
            !filter.status.includes(sf.finding.status)
          ) {
            return false;
          }
          return true;
        })
        .map((sf) => sf.finding);
    },
    countBlocking(filter) {
      let n = 0;
      for (const sf of stored) {
        if (filter?.phase !== undefined && sf.phase !== filter.phase) continue;
        if (sf.finding.severity === "blocking") n += 1;
      }
      return n;
    },
    queryByPhase(phase) {
      return stored
        .filter((sf) => sf.phase === phase)
        .map((sf) => sf.finding);
    },
  };
}

function buildAuditAccess(rows: AuditEntry[]): AuditAccess {
  return {
    recent(filter) {
      let out = rows;
      if (filter.type !== undefined) {
        const t = filter.type;
        out = out.filter((r) => r.type === t);
      }
      if (filter.since !== undefined) {
        const since = filter.since;
        out = out.filter((r) => r.ts >= since);
      }
      if (filter.limit !== undefined) out = out.slice(0, filter.limit);
      return out;
    },
  };
}

function buildAgentRecordsAccess(rows: AgentRecord[]): AgentRecordsAccess {
  return {
    query(filter) {
      let out = rows;
      if (filter.phase !== undefined) {
        const p = filter.phase;
        out = out.filter((r) => r.phase === p);
      }
      if (filter.agent !== undefined) {
        const a = filter.agent;
        out = out.filter((r) => r.agent === a);
      }
      return out;
    },
  };
}

// Parse one audit-row `payload` for the display surface. This is the audit
// DISPLAY reader, and it deliberately TOLERATES a bad blob: a single
// corrupt payload must not blank the entire audit / forensic view, which a
// thrown STATE_CORRUPT would do (it would roll back the whole read). A
// malformed row degrades to `{}` so the surrounding rows still render. The
// authoritative state readers — the snapshot materializer and the
// decisions-merge path — do the opposite and fail loud via `parseStateJson`;
// that leniency is scoped to this display-only reader on purpose.
function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  const s = typeof raw === "string" ? raw : String(raw);
  if (s.length === 0) return {};
  try {
    const parsed = JSON.parse(s) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Tolerated on purpose — see the note above: a malformed audit payload
    // degrades to `{}` rather than aborting the forensic view.
  }
  return {};
}

interface FindingRow {
  id: unknown;
  task_id: unknown;
  agent: unknown;
  iteration: unknown;
  phase: unknown;
  file: unknown;
  line_start: unknown;
  line_end: unknown;
  severity: unknown;
  category: unknown;
  proposed_new_category: unknown;
  pattern_id: unknown;
  summary: unknown;
  evidence_excerpt: unknown;
  suggested_fix: unknown;
  status: unknown;
  ref_rule_id: unknown;
  recorded_at: unknown;
}

interface AuditRow {
  id: unknown;
  ts: unknown;
  type: unknown;
  task_id: unknown;
  driver_state_id: unknown;
  payload: unknown;
  verdict: unknown;
  error_class: unknown;
}

interface AgentRecordRow {
  id: unknown;
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
