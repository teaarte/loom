// A single project's control surface: its live status + log (over SSE), a
// submit-task form, and — when the task is parked on a human gate — the answer
// form. Every action is a PEER of the CLI: submit → `POST /submit`, answer →
// `POST /projects/:id/answer`, the same paths `loom run` / `/proceed` drive.
// Domain-blind: it shows the generic FSM status and carries a generic decision;
// it never interprets a gate. The lifecycle logic lives in hooks (`useSubmitTask`
// / `useAnswerGate` / `useTaskControls`); this view composes the layout.

import {
  Anchor,
  Button,
  Checkbox,
  Collapse,
  Group,
  Paper,
  Select,
  Spoiler,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { useEffect, useState } from "react";

import { History } from "../components/History.js";
import { SpawnTranscriptView } from "../components/SpawnTranscript.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { Trace } from "../components/Trace.js";
import { useAnswerGate } from "../hooks/useAnswerGate.js";
import { useProviders } from "../hooks/useProviders.js";
import { useSSE } from "../hooks/useSSE.js";
import { useSubmitTask } from "../hooks/useSubmitTask.js";
import { useTaskControls } from "../hooks/useTaskControls.js";
import { useTrace } from "../hooks/useTrace.js";
import { cx } from "../lib/cx.js";
import { elapsedFor, formatDetailValue, logParts } from "../lib/format.js";
import { POLICY_PRESETS } from "../lib/policies.js";
import { flowMeta } from "../lib/status.js";
import type { LogLine, ProjectStatus } from "../lib/types.js";
import styles from "./ProjectDetail.module.css";

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
  onOpenSettings,
}: {
  projectId: string;
  dir: string;
  label?: string;
  onBack: () => void;
  onOpenSettings: () => void;
}) {
  const { snapshot, connected } = useSSE(`/projects/${encodeURIComponent(projectId)}/log`);
  // Providers carries Docker availability (for the per-task checkbox); a server
  // without the config API answers 501 → `providers` stays null and the Docker
  // checkbox is simply hidden.
  const { data: providers } = useProviders();
  const status = snapshot?.status ?? null;
  const supervised = snapshot?.supervised ?? false;
  const running = status?.status === "in_progress";
  // A task occupies the slot until it is rotated to history: while one is
  // in_progress the submit form is hidden (it is not logical to submit over a
  // running task); on an empty OR a finished slot the form is shown (a submit
  // auto-archives a finished task first).
  const activeTask = running === true;
  const now = useNow(running ?? false);
  const elapsed = status?.has_task ? elapsedFor(status.started_at, status.ended_at, now) : "";
  const meta = flowMeta(status);

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="center" wrap="nowrap">
        <Group gap="sm" align="center" wrap="wrap">
          <Button variant="subtle" size="compact-sm" onClick={onBack}>
            ← projects
          </Button>
          <Title order={3} m={0}>
            {label ?? projectId}
          </Title>
          <StatusBadge status={status} />
          {elapsed.length > 0 && (
            <Text span size="sm" c="dimmed" className={styles.elapsed}>
              {running ? "⏱ " : "took "}
              {elapsed}
            </Text>
          )}
        </Group>
      </Group>

      <div>
        <Text size="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
          {dir}
        </Text>
        {meta !== null && (
          <Text size="sm" c="dimmed">
            {meta}
          </Text>
        )}
      </div>

      {status?.task && status.task.length > 0 && (
        <Paper withBorder radius="md" p="xs" bg="var(--mantine-color-default)">
          <Text size="xs" c="dimmed" mb={4}>
            task
          </Text>
          <Spoiler maxHeight={72} showLabel="show full task" hideLabel="hide">
            <Text size="sm" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {status.task}
            </Text>
          </Spoiler>
        </Paper>
      )}

      <TaskControls projectId={projectId} status={status} supervised={supervised} />

      {status?.parked_gate && <AnswerForm projectId={projectId} gate={status.parked_gate} />}

      {status && status.pending_agents.length > 0 && (
        <Paper withBorder radius="md" p="xs" className={cx(status.stalled && styles.stalledBox)}>
          <Text size="sm">
            {status.pending_agents.length} pending
            {status.stalled ? " · stalled (likely dropped transport)" : ""}
          </Text>
          {status.pending_agents.map((p) => (
            <Text key={`${p.agent}:${p.phase}`} size="xs" c="dimmed">
              {p.agent} · {p.phase} · {Math.round(p.age_ms / 1000)}s
            </Text>
          ))}
        </Paper>
      )}

      {!activeTask && (
        <SubmitForm
          projectId={projectId}
          {...(providers?.docker !== undefined ? { docker: providers.docker } : {})}
        />
      )}

      <LogPanel log={snapshot?.log ?? null} connected={connected} />

      <section>
        <Title order={4} mb="xs">
          chain
        </Title>
        <Trace projectId={projectId} />
      </section>

      <section>
        <Title order={4} mb="xs">
          history
        </Title>
        <History projectId={projectId} />
      </section>

      <Text size="sm" c="dimmed">
        Models for this project's bundle are edited in{" "}
        <Anchor component="button" type="button" onClick={onOpenSettings}>
          Settings → models
        </Anchor>
        .
      </Text>
    </Stack>
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
  const [pushOnAccept, setPushOnAccept] = useState(false);
  const [mergeOnAccept, setMergeOnAccept] = useState(false);
  const { busy, msg, submit } = useSubmitTask(projectId);

  // Fast-task is the trivial flow — it pins complexity=trivial, so it wins over
  // (and disables) the complexity dropdown.
  const effectiveComplexity = fast ? "trivial" : complexity;
  const dockerAvailable = docker?.available === true;

  const onSubmit = (): void => {
    // Keep the textarea so the operator can re-read / re-submit what they asked.
    void submit({
      task,
      policy,
      complexity: effectiveComplexity,
      docker: useDocker && dockerAvailable,
      push: pushOnAccept,
      squashMerge: mergeOnAccept,
    });
  };

  return (
    <Paper withBorder radius="md" p="md">
      <Stack gap="sm">
        <Text fw={600}>submit a task</Text>
        <Textarea
          autosize
          minRows={4}
          maxRows={16}
          placeholder="add a health check route"
          value={task}
          onChange={(e) => setTask(e.currentTarget.value)}
        />
        <Group gap="md" align="flex-end" wrap="wrap">
          <Select
            label="policy"
            size="xs"
            allowDeselect={false}
            data={POLICY_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
            value={policy}
            onChange={(v) => setPolicy(v ?? "")}
            w={240}
          />
          <Select
            label="complexity"
            size="xs"
            allowDeselect={false}
            disabled={fast}
            data={COMPLEXITY_OPTIONS}
            value={complexity}
            onChange={(v) => setComplexity(v ?? "")}
            w={180}
          />
        </Group>
        <Group gap="lg" wrap="wrap">
          <Checkbox
            label="⚡ fast task"
            checked={fast}
            onChange={(e) => setFast(e.currentTarget.checked)}
          />
          {docker !== undefined && (
            <Checkbox
              label="run in Docker"
              checked={useDocker && dockerAvailable}
              disabled={!dockerAvailable}
              onChange={(e) => setUseDocker(e.currentTarget.checked)}
            />
          )}
          {docker !== undefined && !dockerAvailable && (
            <Text size="xs" c="dimmed">
              Docker unavailable{docker.reason ? ` — ${docker.reason}` : ""}
            </Text>
          )}
        </Group>
        <Group gap="lg" wrap="wrap">
          <Checkbox
            label="push branch on accept"
            checked={pushOnAccept}
            onChange={(e) => setPushOnAccept(e.currentTarget.checked)}
          />
          <Checkbox
            label="squash-merge on accept"
            checked={mergeOnAccept}
            onChange={(e) => setMergeOnAccept(e.currentTarget.checked)}
          />
        </Group>
        <Group gap="sm" align="center">
          <Button onClick={onSubmit} loading={busy}>
            submit
          </Button>
          {msg !== null && (
            <Text size="sm" c="dimmed">
              {msg}
            </Text>
          )}
        </Group>
      </Stack>
    </Paper>
  );
}

// Pause / resume / cancel / archive — first-class buttons over the SAME registry
// machinery the CLI uses (the actions live in `useTaskControls`). The controls
// shown depend on BOTH the store status and `supervised` (is a watcher attached):
//   in_progress + supervised   → ⏸ pause + ✕ cancel
//   in_progress + !supervised  → ▶ resume + ✕ cancel
//   completed / abandoned      → 🗄 archive (free the slot) + ship buttons when
//                                accepted — NO resume (a no-op on a finished task).
function TaskControls({
  projectId,
  status,
  supervised,
}: {
  projectId: string;
  status: ProjectStatus | null;
  supervised: boolean;
}) {
  const { busy, msg, pause, resume, cancel, ship } = useTaskControls(projectId);

  if (!status || !status.has_task) return null;
  const running = status.status === "in_progress";
  const disabled = busy !== null;

  // A finished task: archive it (free the slot); and when accepted, ship it.
  if (!running) {
    const accepted = status.verdict === "accepted";
    return (
      <Group gap="sm" align="center" wrap="wrap">
        {accepted && (
          <>
            <Button variant="default" disabled={disabled} loading={busy === "push"} onClick={() => void ship("push")}>
              ⬆ push branch
            </Button>
            <Button
              variant="default"
              disabled={disabled}
              loading={busy === "merge"}
              onClick={() => void ship("merge")}
            >
              ⤵ squash &amp; merge
            </Button>
          </>
        )}
        <Button color="red" variant="outline" disabled={disabled} loading={busy === "cancelled"} onClick={() => void cancel()}>
          🗄 archive (free the slot)
        </Button>
        {msg !== null && (
          <Text size="sm" c="dimmed">
            {msg}
          </Text>
        )}
      </Group>
    );
  }

  // An in-flight task: pause it if a watcher is driving it, else resume it.
  return (
    <Group gap="sm" align="center" wrap="wrap">
      {supervised ? (
        <Button variant="default" disabled={disabled} loading={busy === "paused"} onClick={() => void pause()}>
          ⏸ pause
        </Button>
      ) : (
        <Button
          variant="default"
          disabled={disabled}
          loading={busy === "resumed"}
          onClick={() => void resume(status.project_dir)}
        >
          ▶ resume
        </Button>
      )}
      <Button color="red" variant="outline" disabled={disabled} loading={busy === "cancelled"} onClick={() => void cancel()}>
        ✕ cancel
      </Button>
      {msg !== null && (
        <Text size="sm" c="dimmed">
          {msg}
        </Text>
      )}
    </Group>
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
  const { busy, msg, answer } = useAnswerGate(projectId);

  const onAnswer = async (): Promise<void> => {
    const ok = await answer({
      gateEventId: gate.gate_event_id,
      decision,
      ...(decision === "reject" ? { rejectIntent } : {}),
      message,
    });
    if (ok) setMessage("");
  };

  return (
    <Paper withBorder radius="md" p="md" className={styles.gateBox}>
      <Stack gap="sm">
        <Text fw={600}>parked on gate: {gate.gate}</Text>
        {gate.message.length > 0 && (
          <Text size="sm" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
            {gate.message}
          </Text>
        )}
        <ApprovalPreview projectId={projectId} />
        <Group gap="md" align="flex-end" wrap="wrap">
          <Select
            label="decision"
            size="xs"
            allowDeselect={false}
            data={["accept", "reject", "auto-apply"]}
            value={decision}
            onChange={(v) => setDecision((v ?? "accept") as typeof decision)}
            w={160}
          />
          {decision === "reject" && (
            <Select
              label="intent"
              size="xs"
              allowDeselect={false}
              data={["revise", "abandon"]}
              value={rejectIntent}
              onChange={(v) => setRejectIntent((v ?? "revise") as typeof rejectIntent)}
              w={160}
            />
          )}
        </Group>
        <TextInput
          placeholder="optional message"
          value={message}
          onChange={(e) => setMessage(e.currentTarget.value)}
        />
        <Group gap="sm" align="center">
          <Button onClick={() => void onAnswer()} loading={busy}>
            answer gate
          </Button>
          {msg !== null && (
            <Text size="sm" c="dimmed">
              {msg}
            </Text>
          )}
        </Group>
      </Stack>
    </Paper>
  );
}

// "Read what you're approving": the parked spawn's output. The store does not say
// which spawn a gate is approving (that is bundle knowledge), so this shows the
// MOST RECENT recorded spawn's transcript — in practice the one that just
// produced the artifact at the gate. Domain-blind: it picks the last chain entry.
function ApprovalPreview({ projectId }: { projectId: string }) {
  const { data } = useTrace(projectId);
  if (data === null || data.agents.length === 0) return null;
  const last = data.agents[data.agents.length - 1];
  if (last === undefined) return null;
  return (
    <div>
      <Text size="xs" c="dimmed" mb={4}>
        what you're approving — {last.agent}
        {last.model !== null && last.model.length > 0 ? ` · ${last.model}` : ""}
      </Text>
      <SpawnTranscriptView projectId={projectId} runId={last.agent_run_id} autoOpen />
    </div>
  );
}

// The live log — collapsible. Collapsed it shows just the last line so the
// section stays compact while a long task runs; expanded it shows the token
// economy line + the bounded tail.
function LogPanel({ log, connected }: { log: LogLine[] | null; connected: boolean }) {
  const [open, setOpen] = useState(true);
  const lastLine = log !== null && log.length > 0 ? logParts(log[log.length - 1] as LogLine) : null;

  return (
    <section>
      <Group gap="xs" align="center" mb="xs">
        <Button variant="subtle" size="compact-sm" onClick={() => setOpen((o) => !o)}>
          {open ? "▾" : "▸"} log
        </Button>
        {connected ? (
          <Text span size="xs" c="green">
            ● live
          </Text>
        ) : (
          <Text span size="xs" c="dimmed">
            stream closed
          </Text>
        )}
        {!open && lastLine !== null && (
          <Text span size="xs" c="dimmed" lineClamp={1}>
            {lastLine.event} {lastLine.detail}
          </Text>
        )}
      </Group>
      <Collapse expanded={open}>
        <CostNote log={log} />
        <LogTail lines={log} />
      </Collapse>
    </section>
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
      {turns > 0 && <> · {turns} turns</>}{" "}
      <span className={styles.costApi}>· ≈ API-equiv {formatDetailValue("cost_usd", cost)}</span>
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
