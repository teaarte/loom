// `loom status [path]` — a read-only snapshot of this project's task: its
// status, where in the flow it sits, any pending agents and how long
// they've been outstanding, and a "stalled" verdict when a pending agent
// has been idle past the kernel's zombie-pending window — the signature of
// a dropped transport (a slept laptop, a closed socket), which `/proceed`
// or `loom resume` re-attaches.
//
// Operator-direct: like `reset`, this does not consult the project
// allowlist — the person at the terminal IS the operator inspecting their
// own directory. The kernel is imported lazily so the SQLite-free install
// commands keep a flag-free launcher; the bin re-execs with the
// experimental-sqlite flag for `status` exactly as it does for `reset`.
//
// Age is computed host-side from the wall clock — outside the kernel,
// where ambient time is fine — and never threaded through a kernel call.
// `nowMs` is injectable so a test pins a deterministic clock.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { firstUnknownFlag, parseArgs } from "../lib/args.js";
import type { CliEnv } from "../lib/env.js";

const STATUS_KNOWN_FLAGS = [] as const;

export async function status(
  argv: string[],
  env: CliEnv,
  nowMs: number = Date.now(),
): Promise<number> {
  const { positionals, flags } = parseArgs(argv);
  const unknown = firstUnknownFlag(flags, STATUS_KNOWN_FLAGS);
  if (unknown !== null) {
    env.err(`loom status: unknown flag --${unknown}`);
    return 1;
  }
  const target =
    positionals.length > 0 && positionals[0] !== undefined
      ? resolve(env.cwd, positionals[0])
      : env.cwd;

  const { withReadTransaction, loadState, projectFootprintDir, ZOMBIE_PENDING_MS } =
    await import("@loomfsm/kernel");

  // Resolving the footprint migrates any legacy `.claude/` store into place.
  if (!existsSync(join(projectFootprintDir(target), "state.db"))) {
    env.out(`no active task in ${target}`);
    return 0;
  }

  let state: Awaited<ReturnType<typeof loadState>>;
  try {
    state = await withReadTransaction(target, loadState);
  } catch {
    // A store that exists but holds no task row (or is unreadable) is, for
    // an operator's purposes, the same as no active task.
    env.out(`no active task in ${target}`);
    return 0;
  }

  const label = taskLabel(state.task_short, state.task);
  env.out(`project:  ${target}`);
  env.out(`task:     ${state.task_id ?? "(unknown)"}${label.length > 0 ? ` — ${label}` : ""}`);

  if (state.status === "completed" || state.status === "abandoned") {
    const verdict = state.verdict !== null ? ` (verdict ${state.verdict})` : "";
    env.out(`status:   ${state.status}${verdict}`);
    env.out(`this task is finished — clear the slot with /done or 'loom reset' to start the next.`);
    return 0;
  }

  env.out(`status:   in_progress`);
  env.out(`flow:     ${state.driver.flow_name} @ step ${state.driver.step_index}`);
  const phase = activePhase(state.phases);
  if (phase !== null) env.out(`phase:    ${phase}`);

  if (state.driver.pending_user_answer !== null) {
    env.out(`paused:   awaiting your answer at gate '${state.driver.pending_user_answer.gate}'`);
    env.out(`          resume with /proceed or 'loom resume'`);
    return 0;
  }

  const pending = state.pending_agents;
  if (pending.length === 0) {
    env.out(`pending:  none dispatched`);
    return 0;
  }

  env.out(`pending:  ${pending.length} agent(s)`);
  let oldestAgeMs = 0;
  for (const row of pending) {
    const ageMs = Math.max(0, nowMs - Date.parse(row.started_at));
    if (ageMs > oldestAgeMs) oldestAgeMs = ageMs;
    env.out(`          - ${row.agent} (${row.phase}) — ${formatAge(ageMs)}`);
  }
  if (oldestAgeMs >= ZOMBIE_PENDING_MS) {
    const mins = Math.round(oldestAgeMs / 60_000);
    env.out(
      `verdict:  stalled ~${mins} min — likely a dropped transport; ` +
        `resume with /proceed or 'loom resume'`,
    );
  }
  return 0;
}

function taskLabel(taskShort: string | null, task: string): string {
  if (taskShort !== null && taskShort.length > 0) return taskShort;
  return task.length > 72 ? `${task.slice(0, 69)}...` : task;
}

function activePhase(phases: { name: string; status: string }[]): string | null {
  for (const p of phases) {
    if (p.status === "in_progress") return p.name;
  }
  return null;
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}
