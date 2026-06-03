// The project read-model — the structured snapshot the HTTP read endpoints
// (`GET /projects` and `GET /projects/:id`) return. It reads the SAME
// canonical `loadState` fields `loom status` prints, so the network view and
// the terminal view never disagree: where in the flow a task sits, whether it
// is parked on a human gate, and how long any pending spawn has been
// outstanding (the "stalled" verdict a dropped transport leaves behind).
//
// Domain-blind: it reads only generic FSM fields (status / flow / phases /
// pending rows / the generic `pending_user_answer` slot) and NEVER the
// bundle's `bundle_state` — the control plane has no business knowing what a
// gate means.
//
// Ambient clock: pending-row ageing is computed host-side from a wall-clock
// reading (`nowMs`, injectable for tests), the same posture `loom status`
// and the daemon's `detectStaleness` take — this is transport code, outside
// the kernel's replay graph.

import { readState } from "@loomfsm/driver";
import { peekArchiveSlot, ZOMBIE_PENDING_MS } from "@loomfsm/kernel";

export interface PendingAgentView {
  agent: string;
  phase: string;
  age_ms: number;
}

export interface ProjectStatusView {
  project_dir: string;
  has_task: boolean;
  task_id: string | null;
  // task_short, or the task text truncated — what an operator reads as the label.
  task_label: string | null;
  status: "in_progress" | "completed" | "abandoned" | null;
  verdict: "accepted" | "rejected" | "failed_force_closed" | null;
  flow: { name: string; step_index: number } | null;
  active_phase: string | null;
  parked_gate: { gate: string; message: string; gate_event_id: string } | null;
  pending_agents: PendingAgentView[];
  // True when the oldest pending row has aged past the kernel's zombie window
  // — the signature of a dropped transport, the same threshold `loom status`
  // flags on.
  stalled: boolean;
}

const EMPTY = (projectDir: string): ProjectStatusView => ({
  project_dir: projectDir,
  has_task: false,
  task_id: null,
  task_label: null,
  status: null,
  verdict: null,
  flow: null,
  active_phase: null,
  parked_gate: null,
  pending_agents: [],
  stalled: false,
});

// Read a project's task snapshot. A store-less project (or one whose store
// carries no task row) is reported as `has_task: false` rather than thrown —
// the same "no active task" an operator sees from `loom status`.
export async function readProjectStatus(
  projectDir: string,
  nowMs: number,
): Promise<ProjectStatusView> {
  let slot: Awaited<ReturnType<typeof peekArchiveSlot>>;
  try {
    slot = await peekArchiveSlot(projectDir);
  } catch {
    // A store that is momentarily unreadable — mid-rotation, or a
    // never-checkpointed WAL seen under the control plane's concurrent
    // connections — must NOT crash the read endpoint. The store is the
    // authority; a transient read failure degrades THIS project's snapshot to
    // "unknown" rather than 500-ing the whole `GET /projects` / log stream.
    return EMPTY(projectDir);
  }
  if (slot === null) return EMPTY(projectDir);

  let state: Awaited<ReturnType<typeof readState>>;
  try {
    state = await readState(projectDir);
  } catch {
    // A store that exists but cannot be loaded is, for a reader's purposes,
    // the same as no active task (mirrors `loom status`).
    return EMPTY(projectDir);
  }

  const pending: PendingAgentView[] = [];
  let oldest = 0;
  for (const row of state.pending_agents) {
    const age = Math.max(0, nowMs - Date.parse(row.started_at));
    if (age > oldest) oldest = age;
    pending.push({ agent: row.agent, phase: row.phase, age_ms: age });
  }

  return {
    project_dir: projectDir,
    has_task: true,
    task_id: state.task_id,
    task_label: taskLabel(state.task_short, state.task),
    status: state.status,
    verdict: state.verdict,
    flow: { name: state.driver.flow_name, step_index: state.driver.step_index },
    active_phase: activePhase(state.phases),
    parked_gate: state.driver.pending_user_answer,
    pending_agents: pending,
    stalled: pending.length > 0 && oldest >= ZOMBIE_PENDING_MS,
  };
}

function taskLabel(taskShort: string | null, task: string): string | null {
  if (taskShort !== null && taskShort.length > 0) return taskShort;
  if (task.length === 0) return null;
  return task.length > 72 ? `${task.slice(0, 69)}...` : task;
}

function activePhase(phases: { name: string; status: string }[]): string | null {
  for (const p of phases) {
    if (p.status === "in_progress") return p.name;
  }
  return null;
}
