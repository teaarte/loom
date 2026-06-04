// A single project's control surface: its live status + log (over SSE), a
// submit-task form, and — when the task is parked on a human gate — the answer
// form. Plus the model-map editor for the project's bundle. Every action is a
// PEER of the CLI: submit → `POST /submit`, answer → `POST /projects/:id/answer`,
// the same paths `loom run` / `/resume` drive. Domain-blind: it shows the
// generic FSM status and carries a generic decision; it never interprets a gate.

import { useState } from "react";

import { api, ApiError } from "../lib/api.js";
import { ModelMap } from "../components/ModelMap.js";
import { useSSE } from "../hooks/useSSE.js";
import { cx } from "../lib/cx.js";
import { POLICY_PRESETS } from "../lib/policies.js";
import { statusBadge, type StatusTone } from "../lib/status.js";
import type { LogLine, ProjectStatus, SubmitResult } from "../lib/types.js";
import styles from "./ProjectDetail.module.css";

const DOT_CLASS: Record<StatusTone, string | undefined> = {
  idle: styles.idle,
  ok: styles.ok,
  warn: styles.warn,
  bad: styles.bad,
};

export function ProjectDetail({
  projectId,
  dir,
  label,
  onBack,
}: {
  projectId: string;
  dir: string;
  label?: string;
  onBack: () => void;
}) {
  const { snapshot, connected } = useSSE(`/projects/${encodeURIComponent(projectId)}/log`);
  const status = snapshot?.status ?? null;
  const badge = statusBadge(status);

  return (
    <div>
      <div className={styles.head}>
        <button className={styles.back} onClick={onBack}>
          ← projects
        </button>
        <h1>{label ?? projectId}</h1>
        <span className={styles.badge}>
          <span className={cx(styles.dot, DOT_CLASS[badge.tone])} />
          {badge.label}
        </span>
      </div>
      <div className={styles.dir}>{dir}</div>

      {status?.flow && (
        <div className={styles.meta}>
          {status.flow.name} @ step {status.flow.step_index}
          {status.active_phase ? ` · ${status.active_phase}` : ""}
          {status.task_label ? ` · ${status.task_label}` : ""}
        </div>
      )}

      {status?.parked_gate && (
        <AnswerForm projectId={projectId} gate={status.parked_gate} />
      )}

      {status && status.pending_agents.length > 0 && (
        <div className={cx(styles.pending, status.stalled && styles.stalledBox)}>
          {status.pending_agents.length} pending{status.stalled ? " · stalled (likely dropped transport)" : ""}
          {status.pending_agents.map((p) => (
            <div key={`${p.agent}:${p.phase}`} className={styles.pendingRow}>
              {p.agent} · {p.phase} · {Math.round(p.age_ms / 1000)}s
            </div>
          ))}
        </div>
      )}

      <SubmitForm projectId={projectId} />

      <h2>log {connected ? <span className={styles.live}>● live</span> : <span className={styles.dead}>stream closed</span>}</h2>
      <LogTail lines={snapshot?.log ?? null} />

      <h2>models</h2>
      <ModelMap projectId={projectId} />
    </div>
  );
}

function SubmitForm({ projectId }: { projectId: string }) {
  const [task, setTask] = useState("");
  const [policy, setPolicy] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const trimmed = task.trim();
    if (trimmed.length === 0) {
      setMsg("enter a task");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<SubmitResult>("POST", "/submit", {
        project: projectId,
        task: trimmed,
        ...(policy.length > 0 ? { policy_preset: policy } : {}),
      });
      setMsg(`${r.replayed ? "already running" : "submitted"} — ${r.task_id ?? "?"} [${r.status}]`);
      setTask("");
    } catch (err) {
      setMsg(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className={styles.box}>
      <legend>submit a task</legend>
      <div className={styles.row}>
        <label className={styles.policyLabel}>
          policy
          <select className={styles.select} value={policy} onChange={(e) => setPolicy(e.target.value)}>
            {POLICY_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <textarea
        className={styles.textarea}
        rows={2}
        placeholder="add a health check route"
        value={task}
        onChange={(e) => setTask(e.target.value)}
      />
      <div className={styles.row}>
        <button className={styles.btn} disabled={busy} onClick={() => void submit()}>
          {busy ? "submitting…" : "submit"}
        </button>
        {msg !== null && <span className={styles.msg}>{msg}</span>}
      </div>
    </fieldset>
  );
}

function AnswerForm({
  projectId,
  gate,
}: {
  projectId: string;
  gate: NonNullable<ProjectStatus["parked_gate"]>;
}) {
  const [decision, setDecision] = useState<"accept" | "reject" | "auto-apply">("accept");
  const [rejectIntent, setRejectIntent] = useState<"revise" | "abandon">("revise");
  const [message, setMessage] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const answer = async (): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      await api("POST", `/projects/${encodeURIComponent(projectId)}/answer`, {
        gate_event_id: gate.gate_event_id,
        decision,
        ...(decision === "reject" ? { reject_intent: rejectIntent } : {}),
        ...(message.trim().length > 0 ? { message: message.trim() } : {}),
      });
      setMsg("delivered");
      setMessage("");
    } catch (err) {
      setMsg(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className={cx(styles.box, styles.gateBox)}>
      <legend>parked on gate: {gate.gate}</legend>
      {gate.message.length > 0 && <div className={styles.gateMsg}>{gate.message}</div>}
      <div className={styles.row}>
        <label className={styles.policyLabel}>
          decision
          <select
            className={styles.select}
            value={decision}
            onChange={(e) => setDecision(e.target.value as typeof decision)}
          >
            <option value="accept">accept</option>
            <option value="reject">reject</option>
            <option value="auto-apply">auto-apply</option>
          </select>
        </label>
        {decision === "reject" && (
          <label className={styles.policyLabel}>
            intent
            <select
              className={styles.select}
              value={rejectIntent}
              onChange={(e) => setRejectIntent(e.target.value as typeof rejectIntent)}
            >
              <option value="revise">revise</option>
              <option value="abandon">abandon</option>
            </select>
          </label>
        )}
      </div>
      <input
        className={styles.input}
        type="text"
        placeholder="optional message"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />
      <div className={styles.row}>
        <button className={styles.btn} disabled={busy} onClick={() => void answer()}>
          {busy ? "delivering…" : "answer gate"}
        </button>
        {msg !== null && <span className={styles.msg}>{msg}</span>}
      </div>
    </fieldset>
  );
}

function LogTail({ lines }: { lines: LogLine[] | null }) {
  if (lines === null) return <pre className={styles.log}>waiting for the stream…</pre>;
  if (lines.length === 0) return <pre className={styles.log}>(no log yet)</pre>;
  const text = lines
    .map((l) => {
      const detail = l.detail !== undefined ? ` ${JSON.stringify(l.detail)}` : "";
      return `${l.ts ?? ""} [${l.level ?? "?"}] ${l.event ?? ""}${detail}`;
    })
    .join("\n");
  return <pre className={styles.log}>{text}</pre>;
}
