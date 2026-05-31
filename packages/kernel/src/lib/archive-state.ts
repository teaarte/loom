// Task-archival rotation primitive — move a finished task's state store
// aside so the next task starts from a clean slot, while the finished
// task's full record is preserved.
//
// Why rotation rather than a multi-task store: the canonical aggregate
// tables are single-row by construction (the `id = 1` identity CHECK), so
// one project store holds exactly one task at a time. Finishing a task
// therefore means MOVING its store aside, not clearing a row — the live
// `<project>/.claude/state.db` is copied to
// `<project>/.claude/history/<task_id>.db` and the live file removed; the
// next task creates a fresh store in the freed slot. A one-line summary is
// appended to `<project>/.claude/history/index.jsonl` so the set of past
// tasks is browsable without opening each archived store.
//
// Consistency: closing the connection pool first checkpoints the
// write-ahead log into the main file (the backend merges the WAL and drops
// its side-files when the last connection closes), so the byte copy that
// follows is a complete snapshot — never a torn read of a main file whose
// WAL still holds committed frames. The copy is then opened and its
// canonical row confirmed BEFORE the live store is deleted, so an
// interruption between copy and delete can only ever leave both files
// present — the record is never lost. A re-run on an already-rotated (or
// absent) slot is a no-op.
//
// Wall-clock discipline: the `archived_at` stamp comes from the threaded
// `now`; this module reads no host clock.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { closeAll, KernelError, readArchivedTaskId } from "../state/db.js";
import { withReadTransaction } from "../state/transaction.js";
import type { NowToken } from "../types/now.js";
import type { Transaction } from "../types/transaction.js";

// One line per archived task in `history/index.jsonl`. Every field except
// `archived_at` is read from the about-to-be-archived store; `archived_at`
// is the threaded `now`. `reason` records the archival trigger when the
// caller supplies one (forensics only).
export interface ArchiveIndexEntry {
  task_id: string | null;
  task_short: string | null;
  task: string | null;
  verdict: string | null;
  status: string | null;
  started_at: string | null;
  ended_at: string | null;
  db_file: string;
  archived_at: NowToken;
  reason?: string;
}

export interface ArchiveStateMeta {
  // The archival trigger, recorded in the index line for forensics
  // (e.g. a graceful finish vs. an automatic slot rotation vs. a manual
  // reset). Free-form — the kernel never branches on it.
  reason?: string;
}

export interface ArchiveStateResult {
  // True when a live store was rotated into history; false when there was
  // nothing to archive (no live store), with `reason` explaining the no-op.
  archived: boolean;
  task_id: string | null;
  // The history file name (relative to `.claude/history/`) and its
  // absolute path, present only when `archived` is true.
  db_file: string | null;
  history_path: string | null;
  reason?: string;
}

// A read-only peek at the single-task slot: its status and task id, or
// null when the project has no live store yet. Callers use it to decide
// whether a slot must be rotated (a terminal task) or refused (a live one)
// before a new task can claim it.
export interface SlotPeek {
  status: string | null;
  task_id: string | null;
}

function stateDbPathFor(projectDir: string): string {
  return join(resolve(projectDir), ".claude", "state.db");
}

// Returns null when there is no live task to act on — either no store at
// all, OR a store that exists (e.g. just-reconciled bundle registrations)
// but carries no canonical task row. Both mean "no active task": there is
// nothing to rotate, and the store must NOT be wiped (that would drop the
// project's installed extensions).
export async function peekArchiveSlot(projectDir: string): Promise<SlotPeek | null> {
  if (!existsSync(stateDbPathFor(projectDir))) return null;
  return await withReadTransaction(projectDir, async (tx) => {
    const row = await tx.queryRow<{ status: unknown; task_id: unknown }>(
      "SELECT status, task_id FROM pipeline_state WHERE id = 1",
    );
    if (row === null) return null;
    return {
      status: row.status === null ? null : String(row.status),
      task_id: row.task_id === null ? null : String(row.task_id),
    };
  });
}

// Rotate the project's live store into history. Idempotent: a call against
// a project with no live store returns `{ archived: false }` without side
// effects. Never deletes the live store until the copy is verified.
export async function archiveStateDb(
  projectDir: string,
  now: NowToken,
  meta?: ArchiveStateMeta,
): Promise<ArchiveStateResult> {
  const resolvedDir = resolve(projectDir);
  const claudeDir = join(resolvedDir, ".claude");
  const stateDbPath = join(claudeDir, "state.db");

  // Nothing to archive — already rotated, or never created.
  if (!existsSync(stateDbPath)) {
    return { archived: false, task_id: null, db_file: null, history_path: null, reason: "no-live-state" };
  }

  // Read the index summary from the live store while the pool is still
  // open; the snapshot read sees committed state under a pinned view. A
  // store with no canonical task row (e.g. only reconciled bundle
  // registrations, no task created yet) is NOT archived — wiping it would
  // drop the project's installed extensions.
  const summary = await withReadTransaction(projectDir, readArchiveSummary);
  if (summary === null) {
    return { archived: false, task_id: null, db_file: null, history_path: null, reason: "no-active-task" };
  }
  const taskId = summary.task_id;
  // A store with no canonical task id (half-initialized / corrupt) still
  // gets archived under a deterministic, filesystem-safe fallback derived
  // from the threaded now — never a host-clock read.
  const dbFile = `${taskId ?? `archived-${sanitizeForFilename(now)}`}.db`;

  // Release every connection so the WAL is checkpointed into the main file
  // and the subsequent byte copy is a consistent snapshot.
  closeAll(projectDir);

  const historyDir = join(claudeDir, "history");
  mkdirSync(historyDir, { recursive: true });
  const historyPath = join(historyDir, dbFile);

  // Copy → verify → (index) → delete. The verify reopens the copy and
  // confirms it carries the expected task before the live store is removed.
  copyFileSync(stateDbPath, historyPath);
  const archivedTaskId = readArchivedTaskId(historyPath);
  if (archivedTaskId !== taskId) {
    throw new KernelError({
      code: "ARCHIVE_VERIFY_FAILED",
      message:
        `archived store task id mismatch (expected '${taskId ?? "null"}', ` +
        `read '${archivedTaskId ?? "null"}') — live store left intact`,
      detail: { history_path: historyPath, expected: taskId, read: archivedTaskId },
    });
  }

  appendIndexEntry(historyDir, {
    ...summary,
    db_file: dbFile,
    archived_at: now,
    ...(meta?.reason !== undefined ? { reason: meta.reason } : {}),
  });

  // Record verified — now it is safe to free the slot. Drop the WAL/SHM
  // side-files too in case the platform left them behind.
  rmSync(stateDbPath, { force: true });
  rmSync(`${stateDbPath}-wal`, { force: true });
  rmSync(`${stateDbPath}-shm`, { force: true });

  return { archived: true, task_id: taskId, db_file: dbFile, history_path: historyPath };
}

export interface ArchiveAndResetOptions {
  // Archive a still-in-progress task instead of refusing. The default
  // refuses an in-progress slot so a live run is never discarded by accident.
  force?: boolean;
}

// Guarded archival for the manual-reset surfaces (the MCP tool + the CLI).
// A terminal slot (a finished or abandoned task) archives cleanly; an
// in-progress task is refused with a typed, actionable error unless `force`
// is set. A project with no live store is a successful no-op.
export async function archiveAndReset(
  projectDir: string,
  now: NowToken,
  opts?: ArchiveAndResetOptions,
): Promise<ArchiveStateResult> {
  const slot = await peekArchiveSlot(projectDir);
  if (slot === null) {
    return { archived: false, task_id: null, db_file: null, history_path: null, reason: "no-live-state" };
  }
  if (slot.status === "in_progress" && opts?.force !== true) {
    throw new KernelError({
      code: "PROJECT_TASK_ACTIVE",
      message:
        "a task is in progress in this project — finish it, recover it, " +
        "or archive it anyway with force",
      detail: { status: slot.status, task_id: slot.task_id },
    });
  }
  return await archiveStateDb(projectDir, now, { reason: opts?.force === true ? "force-reset" : "reset" });
}

interface ArchiveSummaryRow {
  task_id: unknown;
  task: unknown;
  task_short: unknown;
  verdict: unknown;
  status: unknown;
  started_at: unknown;
  ended_at: unknown;
}

async function readArchiveSummary(tx: Transaction): Promise<{
  task_id: string | null;
  task: string | null;
  task_short: string | null;
  verdict: string | null;
  status: string | null;
  started_at: string | null;
  ended_at: string | null;
} | null> {
  const row = await tx.queryRow<ArchiveSummaryRow>(
    "SELECT task_id, task, task_short, verdict, status, started_at, ended_at " +
      "FROM pipeline_state WHERE id = 1",
  );
  // No canonical task row → nothing to summarize; the caller no-ops rather
  // than archiving a taskless store.
  if (row === null) return null;
  const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  return {
    task_id: str(row.task_id),
    task: str(row.task),
    task_short: str(row.task_short),
    verdict: str(row.verdict),
    status: str(row.status),
    started_at: str(row.started_at),
    ended_at: str(row.ended_at),
  };
}

// Append a JSONL summary line, skipping a duplicate for the same archived
// file (the crash-between-copy-and-delete re-run re-copies the same file,
// so its index line must not be written twice).
function appendIndexEntry(historyDir: string, entry: ArchiveIndexEntry): void {
  const indexPath = join(historyDir, "index.jsonl");
  if (existsSync(indexPath)) {
    const lines = readFileSync(indexPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed) as { db_file?: unknown };
        if (parsed.db_file === entry.db_file) return;
      } catch {
        // A malformed pre-existing line never blocks a fresh append.
      }
    }
  }
  appendFileSync(indexPath, `${JSON.stringify(entry)}\n`, "utf8");
}

// Make a NowToken safe as a path segment (the fallback file name when a
// store carries no task id). ISO-8601 colons and dots become dashes.
function sanitizeForFilename(now: NowToken): string {
  return String(now).replace(/[:.]/g, "-");
}
