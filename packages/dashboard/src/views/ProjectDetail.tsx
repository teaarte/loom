// A single project's control surface: its live status + log (over SSE), a
// submit-task form, and — when the task is parked on a human gate — the answer
// form. Plus the model-map editor for the project's bundle. Every action is a
// PEER of the CLI: submit → `POST /submit`, answer → `POST /projects/:id/answer`,
// the same paths `loom run` / `/resume` drive. Domain-blind: it shows the
// generic FSM status and carries a generic decision; it never interprets a gate.

import { useEffect, useState } from "react";

import { api, ApiError } from "../lib/api.js";
import { ModelMap } from "../components/ModelMap.js";
import { useApi } from "../hooks/useApi.js";
import { useSSE } from "../hooks/useSSE.js";
import { cx } from "../lib/cx.js";
import { elapsedFor, formatDetailValue, logParts } from "../lib/format.js";
import { POLICY_PRESETS } from "../lib/policies.js";
import { statusBadge, type StatusTone } from "../lib/status.js";
import type { LogLine, ProjectStatus, ProvidersResponse, SubmitResult } from "../lib/types.js";
import styles from "./ProjectDetail.module.css";

const DOT_CLASS: Record<StatusTone, string | undefined> = {
  idle: styles.idle,
  ok: styles.ok,
  warn: styles.warn,
  bad: styles.bad,
};

const LEVEL_CHIP: Record<string, string | undefined> = {
  info: styles.lvlInfo,
  warn: styles.lvlWarn,
  error: styles.lvlError,
};

// A 1s wall-clock tick so the live-elapsed timer advances while a task runs.
// Stops re-rendering once the task is terminal (the caller passes live=false).
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  return now;
}

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
  // Providers carries Docker availability (for the per-task checkbox); a server
  // without the config API answers 501 → `providers` stays null and the Docker
  // checkbox is simply hidden.
  const { data: providers } = useApi<ProvidersResponse>("/providers");
  const status = snapshot?.status ?? null;
  const badge = statusBadge(status);
  const running = status?.status === "in_progress";
  const now = useNow(running ?? false);
  const elapsed = status?.has_task ? elapsedFor(status.started_at, status.ended_at, now) : "";

  return (
    <div>
      <div className={styles.head}>
        <button className={styles.back} onClick={onBack}>
          ← projects
        </button>
        <h1>{label ?? projectId}</h1>
        <span className={styles.badge}>
          <span className={cx(styles.dot, DOT_CLASS[badge.tone], running && styles.pulse)} />
          {badge.label}
        </span>
        {elapsed.length > 0 && (
          <span className={styles.elapsed}>{running ? "⏱ " : "took "}{elapsed}</span>
        )}
      </div>
      <div className={styles.dir}>{dir}</div>

      {status?.flow && (
        <div className={styles.meta}>
          {status.flow.name} @ step {status.flow.step_index}
          {status.active_phase ? ` · ${status.active_phase}` : ""}
        </div>
      )}

      {status?.task && status.task.length > 0 && (
        <details className={styles.taskFull} open>
          <summary>task</summary>
          <div className={styles.taskText}>{status.task}</div>
        </details>
      )}

      <TaskControls projectId={projectId} status={status} />

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

      <SubmitForm projectId={projectId} {...(providers?.docker !== undefined ? { docker: providers.docker } : {})} />

      <h2>log {connected ? <span className={styles.live}>● live</span> : <span className={styles.dead}>stream closed</span>}</h2>
      <CostNote log={snapshot?.log ?? null} />
      <LogTail lines={snapshot?.log ?? null} />

      <h2>models</h2>
      <ModelMap projectId={projectId} />
    </div>
  );
}

// The complexity selector values, sent as the generic `initial_decisions
// .complexity` create arg. "" = auto (let the bundle decide — the default). The
// rest PIN the complexity, which a bundle may honour to skip re-deciding it.
// "trivial" is the fast-task path: the leanest flow the bundle offers. The
// dashboard names no agent/flow — it forwards a value the bundle interprets.
const COMPLEXITY_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "auto (classify)" },
  { value: "trivial", label: "trivial (fast)" },
  { value: "simple", label: "simple" },
  { value: "medium", label: "medium" },
  { value: "complex", label: "complex" },
];

function SubmitForm({ projectId, docker }: { projectId: string; docker?: { available: boolean; reason?: string } }) {
  const [task, setTask] = useState("");
  const [policy, setPolicy] = useState("");
  const [fast, setFast] = useState(false);
  const [complexity, setComplexity] = useState("");
  const [useDocker, setUseDocker] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Fast-task is the trivial flow — it pins complexity=trivial, so it wins over
  // (and disables) the complexity dropdown.
  const effectiveComplexity = fast ? "trivial" : complexity;
  const dockerAvailable = docker?.available === true;

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
        ...(effectiveComplexity.length > 0
          ? { initial_decisions: { complexity: effectiveComplexity, complexity_pinned: true } }
          : {}),
        ...(useDocker ? { docker: true } : {}),
      });
      setMsg(`${r.replayed ? "already running" : "submitted"} — ${r.task_id ?? "?"} [${r.status}]`);
      // Keep the textarea so the operator can re-read / re-submit what they asked.
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
        <label className={styles.policyLabel}>
          complexity
          <select
            className={styles.select}
            value={complexity}
            disabled={fast}
            onChange={(e) => setComplexity(e.target.value)}
          >
            {COMPLEXITY_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
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
        <label className={styles.check}>
          <input type="checkbox" checked={fast} onChange={(e) => setFast(e.target.checked)} />⚡ fast task
        </label>
        {docker !== undefined && (
          <label className={cx(styles.check, !dockerAvailable && styles.checkDisabled)}>
            <input
              type="checkbox"
              checked={useDocker && dockerAvailable}
              disabled={!dockerAvailable}
              onChange={(e) => setUseDocker(e.target.checked)}
            />
            run in Docker
          </label>
        )}
        {docker !== undefined && !dockerAvailable && (
          <span className={styles.hint}>Docker unavailable{docker.reason ? ` — ${docker.reason}` : ""}</span>
        )}
      </div>
      <div className={styles.row}>
        <button className={styles.btn} disabled={busy} onClick={() => void submit()}>
          {busy ? "submitting…" : "submit"}
        </button>
        {msg !== null && <span className={styles.msg}>{msg}</span>}
      </div>
    </fieldset>
  );
}

// Pause / resume / cancel a task — first-class buttons over the SAME registry
// machinery the CLI uses. Pause = unregister the project (`DELETE /projects/:id`):
// aborts the in-flight drive, releases the lock, KEEPS the task in the store +
// catalog. Resume = re-register (`POST /projects`) → the watcher's
// recover-on-start re-drives the in-flight task idempotently. Cancel = the
// first-class abort+abandon route, freeing the slot in one action. Domain-blind:
// it reasons only about generic status, never a gate's meaning.
function TaskControls({ projectId, status }: { projectId: string; status: ProjectStatus | null }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (!status || !status.has_task) return null;
  const running = status.status === "in_progress";

  const act = async (verb: string, run: () => Promise<unknown>): Promise<void> => {
    setBusy(verb);
    setMsg(null);
    try {
      await run();
      setMsg(`${verb} ✓`);
    } catch (err) {
      setMsg(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(null);
    }
  };

  const pause = (): Promise<void> =>
    act("paused", () => api("DELETE", `/projects/${encodeURIComponent(projectId)}`));
  const resume = (): Promise<void> =>
    act("resumed", () => api("POST", "/projects", { dir: status.project_dir }));
  const cancel = (): Promise<void> =>
    act("cancelled", () => api("POST", `/projects/${encodeURIComponent(projectId)}/cancel`));

  return (
    <div className={styles.controls}>
      {running ? (
        <button className={styles.btn} disabled={busy !== null} onClick={() => void pause()}>
          {busy === "paused" ? "pausing…" : "⏸ pause"}
        </button>
      ) : (
        <button className={styles.btn} disabled={busy !== null} onClick={() => void resume()}>
          {busy === "resumed" ? "resuming…" : "▶ resume"}
        </button>
      )}
      <button className={styles.dangerBtn} disabled={busy !== null} onClick={() => void cancel()}>
        {busy === "cancelled" ? "cancelling…" : "✕ cancel"}
      </button>
      {msg !== null && <span className={styles.msg}>{msg}</span>}
    </div>
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

function usageNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// The token-economy line, derived from the `spawn-usage` events in the live log
// tail. Tokens / turns / cache are the PRIMARY signal (the real constraint on a
// Claude Code subscription is rate-limit/quota); `cost_usd` is relabelled as an
// API-equivalent estimate, NOT real spend on a flat-rate subscription.
function CostNote({ log }: { log: LogLine[] | null }) {
  if (log === null) return null;
  let tokIn = 0;
  let tokOut = 0;
  let cached = 0;
  let turns = 0;
  let cost = 0;
  let n = 0;
  for (const l of log) {
    if (l.event !== "spawn-usage" || l.detail === undefined) continue;
    n += 1;
    tokIn += usageNum(l.detail["tokens_in"]);
    tokOut += usageNum(l.detail["tokens_out"]);
    cached += usageNum(l.detail["tokens_cached"]);
    turns += usageNum(l.detail["num_turns"]);
    cost += usageNum(l.detail["cost_usd"]);
  }
  if (n === 0) return null;
  return (
    <div className={styles.cost}>
      <strong>{tokIn.toLocaleString()}</strong> in · <strong>{tokOut.toLocaleString()}</strong> out
      {cached > 0 && <> · {cached.toLocaleString()} cached</>}
      {turns > 0 && <> · {turns} turns</>} <span className={styles.costApi}>· ≈ API-equiv {formatDetailValue("cost_usd", cost)}</span>
      <span className={styles.hint}> — subscription is flat-rate; tokens/turns/cache are the real signal</span>
    </div>
  );
}

function LogTail({ lines }: { lines: LogLine[] | null }) {
  if (lines === null) return <div className={styles.log}>waiting for the stream…</div>;
  if (lines.length === 0) return <div className={styles.log}>(no log yet)</div>;
  return (
    <div className={styles.log}>
      {lines.map((l, i) => {
        const p = logParts(l);
        return (
          <div className={styles.logLine} key={i}>
            {p.clock.length > 0 && <span className={styles.logClock}>{p.clock}</span>}
            <span className={cx(styles.logChip, LEVEL_CHIP[p.level])}>{p.level}</span>
            {p.event.length > 0 && <span className={styles.logEvent}>{p.event}</span>}
            {p.detail.length > 0 && <span className={styles.logDetail}>{p.detail}</span>}
          </div>
        );
      })}
    </div>
  );
}
