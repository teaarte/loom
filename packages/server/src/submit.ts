// `submitTask` — the create-task path behind `POST /submit`.
//
// This is the intake seam: a thin wrapper over the SAME `createAndStart`
// composition `loom run` and the stdio `pipeline_run_task` tool use, so every
// intake adapter (a dashboard form, a chat bot, an issue poller) reaches the
// kernel through one create path and learns nothing about the domain. It
// creates the task and ticks the FSM to its first directive; it does NOT
// execute it — the project's supervisor watcher sees the slot fill on its next
// poll and drives it. (The watcher cannot be "seeded" after it has started, so
// intake writes the task into the store and the watcher picks it up — exactly
// the seam the supervisor was built around.)
//
// Idempotent by a `client_idempotency_uuid` DERIVED from the task text: a
// duplicate submit replays the cached creation envelope off the
// `task-create:<uuid>` ledger row instead of trying (and failing) to claim the
// occupied slot. A genuinely different task submitted while one is live is a
// typed `PROJECT_TASK_ACTIVE` conflict (the single-task invariant: 2 tasks = 2
// projects).

import { createHash } from "node:crypto";

import { createAndStart } from "@loomfsm/driver";
import {
  archiveStateDb,
  captureNow,
  openDb,
  peekArchiveSlot,
  readLedgerRow,
  TransactionImpl,
  type Registry,
} from "@loomfsm/kernel";

import { fromKernelError, ServerError } from "./errors.js";

export interface SubmitArgs {
  task: string;
  policy_preset?: string;
  // Generic opening-decisions seed threaded straight to the kernel create arg —
  // the server names none of its keys. The dashboard's ⚡ fast-task / complexity
  // selector rides here as `{ complexity, complexity_pinned }`; a bundle reads
  // whatever keys it understands. Domain-blind: the server passes it through.
  initial_decisions?: Record<string, unknown>;
}

export interface SubmitResult {
  task_id: string | null;
  driver_state_id: string;
  // The first directive's wire status (spawn-agent | ask-user | complete | …)
  // — informational; the watcher drives from here.
  status: string;
  // True when this submit replayed an already-created task (same task text).
  replayed: boolean;
}

// Crash-safe, dedup-safe create id from the task text — the same scheme the
// supervisor uses so a submit and a later watcher-seed never collide.
export function deterministicUuid(task: string): string {
  return `cidem-${createHash("sha256").update(task).digest("hex").slice(0, 24)}`;
}

export async function submitTask(
  projectDir: string,
  registry: Registry,
  args: SubmitArgs,
): Promise<SubmitResult> {
  const task = args.task.trim();
  if (task.length === 0) {
    throw new ServerError("TASK_REQUIRED", 400, "a non-empty task is required");
  }
  const uuid = deterministicUuid(task);

  // Replay — a cached creation envelope means this exact task already started.
  const cached = await readCachedCreation(projectDir, uuid);
  if (cached !== null) return { ...cached, replayed: true };

  // Free a finished slot before creating the next task (an in-progress task is
  // NEVER auto-rotated — the create tx refuses it with PROJECT_TASK_ACTIVE).
  try {
    const slot = await peekArchiveSlot(projectDir);
    if (slot !== null && (slot.status === "completed" || slot.status === "abandoned")) {
      await archiveStateDb(projectDir, captureNow(), { reason: "auto-rotate" });
    }
  } catch (err) {
    throw fromKernelError(err);
  }

  try {
    const created = await createAndStart(projectDir, {
      registry,
      task,
      client_idempotency_uuid: uuid,
      ...(args.policy_preset !== undefined ? { policy_preset: args.policy_preset } : {}),
      ...(args.initial_decisions !== undefined ? { initial_decisions: args.initial_decisions } : {}),
    });
    return {
      task_id: created.task_id,
      driver_state_id: created.driver_state_id,
      status: created.response.status,
      replayed: false,
    };
  } catch (err) {
    throw fromKernelError(err);
  }
}

// Read the canonical creation envelope cached on the task-create ledger row.
// The scope is never committed, so the now token threaded here is local.
async function readCachedCreation(
  projectDir: string,
  uuid: string,
): Promise<{ task_id: string | null; driver_state_id: string; status: string } | null> {
  const slot = await peekArchiveSlot(projectDir);
  if (slot === null) return null; // no store yet → nothing cached
  const db = openDb(projectDir);
  const tx = new TransactionImpl(db, captureNow());
  const row = await readLedgerRow(tx, `task-create:${uuid}`);
  if (row === null || row.response_blob === null) return null;
  const response = JSON.parse(row.response_blob) as { status?: unknown };
  const ps = await tx.queryRow<{ task_id: unknown; driver_state_id: unknown }>(
    "SELECT task_id, driver_state_id FROM pipeline_state WHERE id = 1",
  );
  if (ps === null) return null;
  return {
    task_id: ps.task_id !== null ? String(ps.task_id) : null,
    driver_state_id: String(ps.driver_state_id),
    status: typeof response.status === "string" ? response.status : "unknown",
  };
}
