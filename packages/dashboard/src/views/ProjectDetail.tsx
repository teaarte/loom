// A single project's control surface. The layout is STATE-DRIVEN: whatever the
// task needs from the operator right now is the hero — a parked gate renders
// the answer panel first, a finished task its result + ship controls, an empty
// slot the submit form. Everything else (task text, the agent chain, the live
// log) reads in support, in that order. Every action is a PEER of the CLI:
// submit → `POST /submit`, answer → `POST /projects/:id/answer` — the same
// paths `loom run` / `/proceed` drive. Domain-blind: it shows the generic FSM
// status and carries a generic decision; it never interprets a gate.

import {
  Anchor,
  Badge,
  Button,
  Checkbox,
  Collapse,
  Group,
  Paper,
  SegmentedControl,
  Select,
  Spoiler,
  Stack,
  Tabs,
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
import type { LogLine, ProjectStatus, TraceFinding, TraceResponse } from "../lib/types.js";
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
  // One trace subscription for the whole screen: the gate panel's blocker
  // summary, the approval preview, and the chain all read this snapshot.
  const trace = useTrace(projectId);
  const status = snapshot?.status ?? null;
  const supervised = snapshot?.supervised ?? false;
  const running = status?.status === "in_progress";
  // A task occupies the slot until it is rotated to history: while one is
  // in_progress the submit form is hidden; on an empty OR a finished slot the
  // form is shown (a submit auto-archives a finished task first).
  const activeTask = running === true;
  const finished = status?.has_task === true && !running;
  const now = useNow(running ?? false);
  const elapsed = status?.has_task ? elapsedFor(status.started_at, status.ended_at, now) : "";
  const meta = flowMeta(status);
  const paused = running && !supervised;

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
          {paused && (
            <Badge variant="outline" color="gray" styles={{ label: { textTransform: "none" } }}>
              paused — no watcher attached
            </Badge>
          )}
          {elapsed.length > 0 && (
            <Text span size="sm" c="dimmed" className={styles.elapsed}>
              {running ? "⏱ " : "took "}
              {elapsed}
            </Text>
          )}
        </Group>
      </Group>

      <div>
        <Text size="xs" c="dimmed" ff="monospace" style={{ wordBreak: "break-all" }}>
          {dir}
        </Text>
        {meta !== null && (
          <Text size="sm" c="dimmed">
            {meta}
          </Text>
        )}
      </div>

      <Tabs defaultValue="task">
        <Tabs.List>
          <Tabs.Tab value="task">Task</Tabs.Tab>
          <Tabs.Tab value="archive">Archive</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="task" pt="sm">
          <Stack gap="sm">
            {/* ── The hero: what this task needs from the operator right now. ── */}
            {status?.parked_gate && (
              <GatePanel
                projectId={projectId}
                gate={status.parked_gate}
                trace={trace.data}
              />
            )}

            {finished && !status?.parked_gate && (
              <ResultPanel projectId={projectId} status={status} trace={trace.data} />
            )}

            {!activeTask && !finished && (
              <SubmitForm
                projectId={projectId}
                {...(providers?.docker !== undefined ? { docker: providers.docker } : {})}
              />
            )}

            {/* ── Supporting context, in reading order. ── */}
            {status?.task && status.task.length > 0 && (
              <Paper p="xs" bg="var(--mantine-color-default)">
                <Text size="xs" c="dimmed" mb={4}>
                  Task
                </Text>
                <Spoiler maxHeight={72} showLabel="show full task" hideLabel="hide">
                  <Text size="sm" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    {status.task}
                  </Text>
                </Spoiler>
              </Paper>
            )}

            {running && <TaskControls projectId={projectId} status={status} supervised={supervised} />}

            {status && status.pending_agents.length > 0 && (
              <Paper p="xs" className={cx(status.stalled && styles.stalledBox)}>
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

            {/* Re-submit after a finished task: kept below the result so "what
                happened" reads before "what's next". */}
            {finished && (
              <SubmitForm
                projectId={projectId}
                {...(providers?.docker !== undefined ? { docker: providers.docker } : {})}
              />
            )}

            <section>
              <Title order={4} mb="xs">
                Agent chain
              </Title>
              <Trace projectId={projectId} />
            </section>

            {/* The log lives UNDER the chain and is collapsed by default — the chain
                is the primary read; the log is the drill-down. */}
            <LogPanel log={snapshot?.log ?? null} connected={connected} />
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="archive" pt="sm">
          <History projectId={projectId} />
        </Tabs.Panel>
      </Tabs>

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
// The dashboard names no agent/flow — it forwards a value the bundle interprets.
const COMPLEXITY_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "auto (classify)" },
  { value: "trivial", label: "trivial (fast)" },
  { value: "simple", label: "simple" },
  { value: "medium", label: "medium" },
  { value: "complex", label: "complex" },
  { value: "question", label: "question (answer, no edits)" },
];

// Plain-language hint for the Docker-off state: the server reports the raw
// `--docker requires container isolation, but <why>` (a CLI-flag message); strip
// that prefix so the dashboard shows just the actionable cause.
function dockerHint(reason?: string): string {
  const r = reason ?? "Docker is not set up";
  return r.replace(/^--docker requires container isolation, but\s*/i, "");
}

function SubmitForm({ projectId, docker }: { projectId: string; docker?: { available: boolean; reason?: string } }) {
  const dockerAvailable = docker?.available === true;
  const [task, setTask] = useState("");
  const [policy, setPolicy] = useState("");
  const [complexity, setComplexity] = useState("");
  // Default ON when Docker isolation is actually usable (daemon + image + cred),
  // so an equipped project runs in a container by default; falls back to the
  // host worktree (and the box is disabled) when it is not.
  const [useDocker, setUseDocker] = useState(() => dockerAvailable);
  const [pushOnAccept, setPushOnAccept] = useState(false);
  const [mergeOnAccept, setMergeOnAccept] = useState(false);
  const { busy, msg, submit } = useSubmitTask(projectId);

  const onSubmit = (): void => {
    // Keep the textarea so the operator can re-read / re-submit what they asked.
    void submit({
      task,
      policy,
      complexity,
      docker: useDocker && dockerAvailable,
      push: pushOnAccept,
      squashMerge: mergeOnAccept,
    });
  };

  return (
    <Paper p="md">
      <Stack gap="sm">
        <Text fw={600}>Submit a task</Text>
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
            label="Policy"
            size="xs"
            allowDeselect={false}
            data={POLICY_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
            value={policy}
            onChange={(v) => setPolicy(v ?? "")}
            w={240}
          />
          <Select
            label="Complexity"
            size="xs"
            allowDeselect={false}
            data={COMPLEXITY_OPTIONS}
            value={complexity}
            onChange={(v) => setComplexity(v ?? "")}
            w={180}
          />
        </Group>
        {docker !== undefined && (
          <Group gap="sm" wrap="wrap" align="center">
            <Checkbox
              label="run in Docker (isolated)"
              checked={useDocker && dockerAvailable}
              disabled={!dockerAvailable}
              onChange={(e) => setUseDocker(e.currentTarget.checked)}
            />
            {!dockerAvailable && (
              <Text size="xs" c="dimmed">
                off — {dockerHint(docker.reason)}
              </Text>
            )}
          </Group>
        )}
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
            Submit
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

// Pause / resume / cancel for an in-flight task — first-class buttons over the
// SAME registry machinery the CLI uses (the actions live in `useTaskControls`):
//   in_progress + supervised   → ⏸ pause + ✕ cancel
//   in_progress + !supervised  → ▶ resume + ✕ cancel
function TaskControls({
  projectId,
  status,
  supervised,
}: {
  projectId: string;
  status: ProjectStatus | null;
  supervised: boolean;
}) {
  const { busy, msg, pause, resume, cancel } = useTaskControls(projectId);

  if (!status || !status.has_task || status.status !== "in_progress") return null;
  const disabled = busy !== null;

  return (
    <Group gap="sm" align="center" wrap="wrap">
      {supervised ? (
        <Button variant="default" disabled={disabled} loading={busy === "paused"} onClick={() => void pause()}>
          ⏸ Pause
        </Button>
      ) : (
        <Button
          variant="default"
          disabled={disabled}
          loading={busy === "resumed"}
          onClick={() => void resume(status.project_dir)}
        >
          ▶ Resume
        </Button>
      )}
      <Button color="red" variant="outline" disabled={disabled} loading={busy === "cancelled"} onClick={() => void cancel()}>
        ✕ Cancel
      </Button>
      {msg !== null && (
        <Text size="sm" c="dimmed">
          {msg}
        </Text>
      )}
    </Group>
  );
}

// A finished task's hero: the verdict, the bundle's completion note, and what
// to do with the work — ship it (push / squash-merge) or archive the slot.
// Archiving is routine housekeeping, not destruction: the task moves to the
// archive tab — so the button is neutral, not red.
function ResultPanel({
  projectId,
  status,
  trace,
}: {
  projectId: string;
  status: ProjectStatus;
  trace: TraceResponse | null;
}) {
  const { busy, msg, cancel, ship } = useTaskControls(projectId);
  const accepted = status.verdict === "accepted";
  const disabled = busy !== null;
  const summary = trace?.summary?.completion_summary ?? null;

  return (
    <Paper p="md" className={accepted ? styles.resultOk : undefined}>
      <Stack gap="sm">
        <Group gap="sm">
          <Text fw={600}>{accepted ? "Task accepted" : `Task ${status.verdict ?? status.status ?? "finished"}`}</Text>
        </Group>
        {summary !== null && summary.length > 0 && (
          <Spoiler maxHeight={120} showLabel="show full summary" hideLabel="hide">
            <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
              {summary}
            </Text>
          </Spoiler>
        )}
        <Group gap="sm" align="center" wrap="wrap">
          {accepted && (
            <>
              <Button disabled={disabled} loading={busy === "push"} onClick={() => void ship("push")}>
                ⬆ Push branch
              </Button>
              <Button disabled={disabled} loading={busy === "merge"} onClick={() => void ship("merge")}>
                ⤵ Squash &amp; merge
              </Button>
            </>
          )}
          <Button
            variant="default"
            disabled={disabled}
            loading={busy === "cancelled"}
            onClick={() => void cancel()}
          >
            🗄 Archive task
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

const DECISION_HINT: Record<string, string> = {
  accept: "approve this gate and let the run continue",
  reject: "send it back — choose whether the run revises or stops",
  "auto-apply": "approve AND let the remaining gates of this task decide themselves",
};

// The parked-gate hero. Decision first, evidence right under it: the open
// blocking findings across the whole chain (the actual reasons it parked),
// then the latest spawn's transcript ("read what you're approving").
function GatePanel({
  projectId,
  gate,
  trace,
}: {
  projectId: string;
  gate: NonNullable<ProjectStatus["parked_gate"]>;
  trace: TraceResponse | null;
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

  const blockers = openBlockers(trace);

  return (
    <Paper p="md" className={styles.gateBox}>
      <Stack gap="sm">
        <Group gap="sm">
          <Badge color="yellow" variant="filled" styles={{ label: { textTransform: "none" } }}>
            needs your decision
          </Badge>
          <Text fw={600}>{gate.gate}</Text>
        </Group>
        {gate.message.length > 0 && (
          <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
            {gate.message}
          </Text>
        )}

        {blockers.length > 0 && (
          <Paper p="xs" bg="var(--mantine-color-default)">
            <Text size="xs" fw={600} c="dimmed" mb={6}>
              Open blockers ({blockers.length})
            </Text>
            <Stack gap={6}>
              {blockers.map((f) => (
                <Group key={f.id} gap={8} wrap="nowrap" align="flex-start">
                  <Badge size="xs" color="red" variant="light" style={{ flexShrink: 0 }} styles={{ label: { textTransform: "none" } }}>
                    {f.category}
                  </Badge>
                  <Text size="xs" style={{ minWidth: 0 }}>
                    {f.file !== null && (
                      <Text span size="xs" ff="monospace" c="dimmed">
                        {f.file}
                        {f.line_start !== null ? `:${f.line_start}` : ""}{" "}
                      </Text>
                    )}
                    {f.summary}
                  </Text>
                </Group>
              ))}
            </Stack>
          </Paper>
        )}

        <div>
          <SegmentedControl
            size="sm"
            value={decision}
            onChange={(v) => setDecision(v as typeof decision)}
            data={[
              { value: "accept", label: "Accept" },
              { value: "reject", label: "Reject" },
              { value: "auto-apply", label: "Auto-apply" },
            ]}
          />
          <Text size="xs" c="dimmed" mt={4}>
            {DECISION_HINT[decision]}
          </Text>
        </div>

        {decision === "reject" && (
          <Select
            label="On reject"
            size="xs"
            allowDeselect={false}
            data={[
              { value: "revise", label: "revise — send the work back for another round" },
              { value: "abandon", label: "abandon — stop the task" },
            ]}
            value={rejectIntent}
            onChange={(v) => setRejectIntent((v ?? "revise") as typeof rejectIntent)}
            w={360}
          />
        )}

        <TextInput
          placeholder="optional message to the run"
          value={message}
          onChange={(e) => setMessage(e.currentTarget.value)}
        />
        <Group gap="sm" align="center">
          <Button color="yellow" onClick={() => void onAnswer()} loading={busy}>
            Answer gate
          </Button>
          {msg !== null && (
            <Text size="sm" c="dimmed">
              {msg}
            </Text>
          )}
        </Group>

        <ApprovalPreview projectId={projectId} trace={trace} />
      </Stack>
    </Paper>
  );
}

// The open blocking findings — the concrete reasons a gate parked. Generic:
// reads only the store columns (severity/status), interprets no category.
function openBlockers(trace: TraceResponse | null): TraceFinding[] {
  if (trace === null) return [];
  return trace.findings.filter((f) => f.severity === "blocking" && f.status === "open").slice(0, 8);
}

// "Read what you're approving": the parked spawn's output. The store does not say
// which spawn a gate is approving (that is bundle knowledge), so this shows the
// MOST RECENT recorded spawn's transcript — in practice the one that just
// produced the artifact at the gate. Domain-blind: it picks the last chain entry.
function ApprovalPreview({ projectId, trace }: { projectId: string; trace: TraceResponse | null }) {
  if (trace === null || trace.agents.length === 0) return null;
  const last = trace.agents[trace.agents.length - 1];
  if (last === undefined) return null;
  return (
    <div>
      <Text size="xs" c="dimmed" mb={4}>
        What you're approving — {last.agent}
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
  const [open, setOpen] = useState(false);
  const lastLine = log !== null && log.length > 0 ? logParts(log[log.length - 1] as LogLine) : null;

  return (
    <section>
      <Group gap="xs" align="center" mb="xs">
        <Button variant="subtle" size="compact-sm" onClick={() => setOpen((o) => !o)}>
          {open ? "▾" : "▸"} Log
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
