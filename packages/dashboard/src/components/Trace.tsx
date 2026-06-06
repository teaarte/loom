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

import { api, errText } from "../lib/api.js";
import { useApi } from "../hooks/useApi.js";
import { useTrace } from "../hooks/useTrace.js";
import { cx } from "../lib/cx.js";
import { SpawnTranscriptView } from "./SpawnTranscript.js";
import { formatDuration } from "../lib/format.js";
import {
  deriveAgentDurations,
  findingsForAgent,
  tokenSummary,
  totalTime,
  verdictsForAgent,
  type TimedAgent,
} from "../lib/trace.js";
import type {
  ArtifactContent,
  ArtifactsResponse,
  TraceFinding,
  TraceGate,
  TraceVerdict,
} from "../lib/types.js";
import styles from "./Trace.module.css";

const SEV_CLASS: Record<string, string | undefined> = {
  blocking: styles.sevBlocking,
  warn: styles.sevWarn,
  info: styles.sevInfo,
};

export function Trace({ projectId, archivedTaskId }: { projectId: string; archivedTaskId?: string }) {
  const { data, error } = useTrace(projectId, archivedTaskId);

  if (error !== null) {
    return <div className={styles.note}>could not read the chain: {error.message}</div>;
  }
  if (data === null) return <div className={styles.note}>reading the chain…</div>;
  if (data.agents.length === 0) {
    return <div className={styles.note}>no agent runs recorded yet</div>;
  }

  const timed = deriveAgentDurations(data.agents, data.summary?.started_at ?? null);
  const totalMs = totalTime(data);
  const summaryNote = data.summary?.completion_summary ?? null;

  return (
    <div>
      {summaryNote !== null && summaryNote.length > 0 && (
        <div className={styles.summary}>
          <span className={styles.summaryLabel}>summary</span> {summaryNote}
        </div>
      )}
      {totalMs !== null && (
        <div className={styles.total}>
          total {formatDuration(totalMs)} · {data.agents.length} run{data.agents.length === 1 ? "" : "s"}
        </div>
      )}
      <ol className={styles.chain}>
        {timed.map((a, i) => (
          <li key={a.agent_run_id} className={styles.step}>
            {i > 0 && <span className={styles.arrow}>→</span>}
            <AgentCard projectId={projectId} agent={a} findings={data.findings} verdicts={data.verdicts} />
          </li>
        ))}
      </ol>
      {data.gates.length > 0 && <Gates gates={data.gates} />}
      {archivedTaskId === undefined && <Artifacts projectId={projectId} />}
    </div>
  );
}

function AgentCard({
  projectId,
  agent,
  findings,
  verdicts,
}: {
  projectId: string;
  agent: TimedAgent;
  findings: TraceFinding[];
  verdicts: TraceVerdict[];
}) {
  const [open, setOpen] = useState(false);
  const mine = findingsForAgent(findings, agent.agent, agent.phase);
  const myVerdicts = verdictsForAgent(verdicts, agent.agent, agent.phase);
  // Every run now drills in: at minimum its transcript (prompt + output) is
  // readable, plus any structured findings/verdicts it produced.
  const tokens = tokenSummary(agent);

  return (
    <div className={styles.card}>
      <button
        className={cx(styles.cardHead, styles.clickable)}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={styles.agent}>{agent.agent}</span>
        <span className={styles.kind}>{agent.output_kind}</span>
        {agent.model !== null && <span className={styles.model}>{agent.model}</span>}
        {agent.duration_ms !== null && <span className={styles.dur}>{formatDuration(agent.duration_ms)}</span>}
        {tokens.length > 0 && <span className={styles.tokens}>{tokens}</span>}
        <span className={styles.caret}>{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className={styles.drill}>
          <SpawnTranscriptView projectId={projectId} runId={agent.agent_run_id} />
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
      setErr(errText(e));
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
