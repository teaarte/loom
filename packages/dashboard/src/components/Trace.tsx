// The agent-chain view: the ordered chain of runs a task recorded, each with its
// model, token usage, and a DERIVED duration, drilling in to the structured
// findings / verdicts that run produced and the gates the task decided. Reused
// verbatim for a finished task (read-only, over its archived store) — same shape,
// same component. Plus the prose documents the work agents wrote into the live
// task's sandbox.
//
// Domain-blind: it renders agent / gate / output-kind names as DATA off the API
// and hardcodes none. A PEER reader of the same store `loom status` reads.

import { useState } from "react";

import { api, ApiError } from "../lib/api.js";
import { useApi } from "../hooks/useApi.js";
import { cx } from "../lib/cx.js";
import { formatDuration } from "../lib/format.js";
import {
  deriveAgentDurations,
  findingsForAgent,
  tokenSummary,
  verdictsForAgent,
  type TimedAgent,
} from "../lib/trace.js";
import type {
  ArtifactContent,
  ArtifactsResponse,
  TraceFinding,
  TraceGate,
  TraceResponse,
  TraceVerdict,
} from "../lib/types.js";
import styles from "./Trace.module.css";

const SEV_CLASS: Record<string, string | undefined> = {
  blocking: styles.sevBlocking,
  warn: styles.sevWarn,
  info: styles.sevInfo,
};

export function Trace({ projectId, archivedTaskId }: { projectId: string; archivedTaskId?: string }) {
  const path =
    archivedTaskId !== undefined
      ? `/projects/${encodeURIComponent(projectId)}/trace?task=${encodeURIComponent(archivedTaskId)}`
      : `/projects/${encodeURIComponent(projectId)}/trace`;
  // The live chain may grow as spawns complete, so poll it; an archived chain is
  // static — fetch it once.
  const { data, error } = useApi<TraceResponse>(path, archivedTaskId === undefined ? 4000 : undefined);

  if (error !== null) {
    return <div className={styles.note}>could not read the chain: {error.message}</div>;
  }
  if (data === null) return <div className={styles.note}>reading the chain…</div>;
  if (data.agents.length === 0) {
    return <div className={styles.note}>no agent runs recorded yet</div>;
  }

  const timed = deriveAgentDurations(data.agents, data.summary?.started_at ?? null);
  const totalMs = totalTime(data);

  return (
    <div>
      {totalMs !== null && (
        <div className={styles.total}>
          total {formatDuration(totalMs)} · {data.agents.length} run{data.agents.length === 1 ? "" : "s"}
        </div>
      )}
      <ol className={styles.chain}>
        {timed.map((a, i) => (
          <li key={a.agent_run_id} className={styles.step}>
            {i > 0 && <span className={styles.arrow}>→</span>}
            <AgentCard agent={a} findings={data.findings} verdicts={data.verdicts} />
          </li>
        ))}
      </ol>
      {data.gates.length > 0 && <Gates gates={data.gates} />}
      {archivedTaskId === undefined && <Artifacts projectId={projectId} />}
    </div>
  );
}

// Total wall-clock for the task: started_at → ended_at when terminal, else to the
// last run's persist time so an in-flight chain still shows elapsed-so-far.
function totalTime(t: TraceResponse): number | null {
  const start = parse(t.summary?.started_at ?? null);
  if (start === null) return null;
  const last = t.agents.length > 0 ? parse(t.agents[t.agents.length - 1]?.recorded_at ?? null) : null;
  const end = parse(t.summary?.ended_at ?? null) ?? last;
  if (end === null || end < start) return null;
  return end - start;
}

function parse(iso: string | null): number | null {
  if (iso === null || iso.length === 0) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function AgentCard({
  agent,
  findings,
  verdicts,
}: {
  agent: TimedAgent;
  findings: TraceFinding[];
  verdicts: TraceVerdict[];
}) {
  const [open, setOpen] = useState(false);
  const mine = findingsForAgent(findings, agent.agent, agent.phase);
  const myVerdicts = verdictsForAgent(verdicts, agent.agent, agent.phase);
  const hasDrill = mine.length > 0 || myVerdicts.length > 0;
  const tokens = tokenSummary(agent);

  return (
    <div className={styles.card}>
      <button
        className={cx(styles.cardHead, hasDrill && styles.clickable)}
        onClick={() => hasDrill && setOpen((o) => !o)}
      >
        <span className={styles.agent}>{agent.agent}</span>
        <span className={styles.kind}>{agent.output_kind}</span>
        {agent.model !== null && <span className={styles.model}>{agent.model}</span>}
        {agent.duration_ms !== null && <span className={styles.dur}>{formatDuration(agent.duration_ms)}</span>}
        {tokens.length > 0 && <span className={styles.tokens}>{tokens}</span>}
        {hasDrill && <span className={styles.caret}>{open ? "▾" : "▸"}</span>}
      </button>
      {open && (
        <div className={styles.drill}>
          {myVerdicts.map((v, i) => (
            <div key={i} className={styles.verdict}>
              <strong>{v.verdict}</strong>
              {v.summary_line !== null && v.summary_line.length > 0 && <> — {v.summary_line}</>}
              <span className={styles.counts}>
                {v.blocking_issues > 0 && <span className={styles.sevBlocking}>{v.blocking_issues} blocking</span>}
                {v.warn_issues > 0 && <span className={styles.sevWarn}>{v.warn_issues} warn</span>}
                {v.info_issues > 0 && <span className={styles.sevInfo}>{v.info_issues} info</span>}
              </span>
            </div>
          ))}
          {mine.map((f) => (
            <div key={f.id} className={styles.finding}>
              <span className={cx(styles.sev, SEV_CLASS[f.severity])}>{f.severity}</span>
              <span className={styles.cat}>{f.category}</span>
              {f.file !== null && (
                <span className={styles.loc}>
                  {f.file}
                  {f.line_start !== null ? `:${f.line_start}` : ""}
                </span>
              )}
              <div className={styles.findingSummary}>{f.summary}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Gates({ gates }: { gates: TraceGate[] }) {
  return (
    <div className={styles.gates}>
      <div className={styles.gatesHead}>gates</div>
      {gates.map((g) => (
        <div key={g.name} className={styles.gateRow}>
          <span className={styles.gateName}>{g.name}</span>
          <span className={styles.gateStatus}>{g.status}</span>
          <span className={styles.gateBy}>{g.decided_by}</span>
          {g.feedback !== null && g.feedback.length > 0 && <span className={styles.gateFb}>{g.feedback}</span>}
        </div>
      ))}
    </div>
  );
}

// The prose documents the task's work agents wrote into its sandbox `.claude/`
// (e.g. a context doc, a plan, a hand-off). Read-only and on-demand: a row opens
// the document inline. Live-task only — a finished task's sandbox is discarded.
function Artifacts({ projectId }: { projectId: string }) {
  const { data } = useApi<ArtifactsResponse>(`/projects/${encodeURIComponent(projectId)}/artifacts`, 8000);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [content, setContent] = useState<ArtifactContent | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (data === null || data.artifacts.length === 0) return null;

  const toggle = async (path: string): Promise<void> => {
    if (openPath === path) {
      setOpenPath(null);
      setContent(null);
      return;
    }
    setOpenPath(path);
    setContent(null);
    setErr(null);
    try {
      const c = await api<ArtifactContent>(
        "GET",
        `/projects/${encodeURIComponent(projectId)}/artifact?path=${encodeURIComponent(path)}`,
      );
      setContent(c);
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e));
    }
  };

  return (
    <div className={styles.docs}>
      <div className={styles.gatesHead}>documents</div>
      {data.artifacts.map((a) => (
        <div key={a.path} className={styles.docItem}>
          <button className={styles.docBtn} onClick={() => void toggle(a.path)}>
            {openPath === a.path ? "▾" : "▸"} {a.path}
          </button>
          {openPath === a.path && (
            <div className={styles.docBody}>
              {err !== null ? err : content === null ? "reading…" : content.content}
              {content?.truncated === true && <div className={styles.note}>… (truncated)</div>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
