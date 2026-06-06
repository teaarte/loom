import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";

import { reconcileExtensions, type DiscoveredManifest } from "../src/extension-loader.js";
import {
  archiveAndReset,
  archiveStateDb,
  peekArchiveSlot,
} from "../src/lib/archive-state.js";
import { completeTask } from "../src/lib/complete-task.js";
import { initializeTask } from "../src/lib/initialize-task.js";
import { KernelError, closeDb, loadState, openDb, withStateTransaction } from "../src/state.js";
import type { NowToken } from "../src/types/now.js";

const NOW = "2026-05-31T12:00:00.000Z" as NowToken;

function bundleManifest(name: string): DiscoveredManifest {
  return {
    path: `/fixture/bundle/${name}`,
    raw: {
      manifest_version: "1.0",
      name,
      display_name: name,
      description: "fixture bundle",
      version: "1.0.0",
      kind: "bundle",
      publisher: "@loom",
      capabilities: [],
      requires: { kernel_api: "^3.0.0" },
    },
  };
}

const dirs: string[] = [];

async function freshProject(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "loom-archive-"));
  dirs.push(dir);
  openDb(dir);
  await reconcileExtensions({ manifests: [bundleManifest("code-fixture")], project_dir: dir, now: NOW });
  return dir;
}

async function seedTask(dir: string, uuid: string, task: string): Promise<string> {
  const ids = await withStateTransaction(dir, NOW, (tx) =>
    initializeTask(tx, { project_dir: dir, task, client_idempotency_uuid: uuid, phases: ["context", "work"] }),
  );
  return ids.task_id;
}

// Finalize the task to a non-null verdict (sweeps the open phases so the
// verdict invariant holds), and seed one finding so the archived store
// carries real review output.
async function finalize(dir: string, verdict: "accepted" | "rejected"): Promise<void> {
  await withStateTransaction(dir, NOW, async (tx) => {
    const state = await loadState(tx);
    await completeTask(tx, state.phases, verdict, NOW, "finished");
    await tx.exec(
      "INSERT INTO findings (id, task_id, agent, iteration, phase, severity, category, summary, recorded_at) " +
        "VALUES ('f-1', ?, 'reviewer', 1, 'work', 'info', 'style', 'a noted nit', ?)",
      [state.task_id, NOW],
    );
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      closeDb(dir);
    } catch {
      /* already closed by an archive */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("archiveStateDb", () => {
  it("rotates a finished task into history, writes an index line, and frees the slot", async () => {
    const dir = await freshProject();
    const taskId = await seedTask(dir, "uuid-1", "ship the feature");
    await finalize(dir, "accepted");

    const result = await archiveStateDb(dir, NOW);

    assert.equal(result.archived, true);
    assert.equal(result.task_id, taskId);
    assert.equal(result.db_file, `${taskId}.db`);

    // The live slot is freed and the snapshot landed in history.
    assert.equal(existsSync(join(dir, ".loom", "state.db")), false);
    assert.ok(result.history_path !== null && existsSync(result.history_path));
    assert.equal(existsSync(join(dir, ".loom", "history", `${taskId}.db`)), true);

    // The index carries the summary read from the about-to-be-archived store.
    const indexPath = join(dir, ".loom", "history", "index.jsonl");
    const lines = readFileSync(indexPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    assert.equal(entry["task_id"], taskId);
    assert.equal(entry["status"], "completed");
    assert.equal(entry["verdict"], "accepted");
    assert.equal(entry["task"], "ship the feature");
    assert.equal(entry["archived_at"], NOW);
    assert.equal(entry["db_file"], `${taskId}.db`);
  });

  it("produces a valid, openable archive carrying the finished task's findings + verdict", async () => {
    const dir = await freshProject();
    const taskId = await seedTask(dir, "uuid-2", "fix the bug");
    await finalize(dir, "rejected");

    const result = await archiveStateDb(dir, NOW);
    assert.ok(result.history_path !== null);

    // Open the archived store directly — it is a self-contained DB, not a
    // text dump — and confirm it carries the canonical row + the finding.
    const db = new DatabaseSync(result.history_path);
    try {
      const ps = db.prepare("SELECT task_id, status, verdict FROM pipeline_state WHERE id = 1").get() as
        | { task_id: string; status: string; verdict: string }
        | undefined;
      assert.ok(ps !== undefined);
      assert.equal(ps.task_id, taskId);
      assert.equal(ps.status, "completed");
      assert.equal(ps.verdict, "rejected");
      const finding = db.prepare("SELECT summary FROM findings WHERE id = 'f-1'").get() as
        | { summary: string }
        | undefined;
      assert.ok(finding !== undefined);
      assert.equal(finding.summary, "a noted nit");
    } finally {
      db.close();
    }
  });

  it("is an idempotent no-op when there is no live store to archive", async () => {
    const dir = await freshProject();
    await seedTask(dir, "uuid-3", "first task");
    await finalize(dir, "accepted");

    const first = await archiveStateDb(dir, NOW);
    assert.equal(first.archived, true);

    // Second call: the live store is already gone — no throw, no side effect,
    // no duplicate index line.
    const second = await archiveStateDb(dir, NOW);
    assert.equal(second.archived, false);
    assert.equal(second.reason, "no-live-state");

    const lines = readFileSync(join(dir, ".loom", "history", "index.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    assert.equal(lines.length, 1);
  });

  it("does not lose the record on a re-run mid-rotation (copy + verify precede delete)", async () => {
    // Simulate an interruption AFTER the snapshot copied + indexed but
    // BEFORE the live store was deleted: both files present. A re-run must
    // re-verify the existing copy, NOT duplicate the index line, and then
    // free the slot — the record survives the interruption.
    const dir = await freshProject();
    const taskId = await seedTask(dir, "uuid-4", "interrupted task");
    await finalize(dir, "accepted");

    // First rotation, then put the live store back (the "crash before delete"
    // shape: history copy + index line exist, state.db still present).
    const first = await archiveStateDb(dir, NOW);
    const { copyFileSync } = await import("node:fs");
    copyFileSync(first.history_path as string, join(dir, ".loom", "state.db"));
    assert.equal(existsSync(join(dir, ".loom", "state.db")), true);

    const second = await archiveStateDb(dir, NOW);
    assert.equal(second.archived, true);
    assert.equal(second.task_id, taskId);
    // Slot freed again; the index still has exactly one line for this file.
    assert.equal(existsSync(join(dir, ".loom", "state.db")), false);
    const lines = readFileSync(join(dir, ".loom", "history", "index.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    assert.equal(lines.length, 1);
  });
});

describe("peekArchiveSlot", () => {
  it("reports the live task's status + id, and null when no store exists", async () => {
    const empty = mkdtempSync(join(tmpdir(), "loom-archive-empty-"));
    dirs.push(empty);
    assert.equal(await peekArchiveSlot(empty), null);

    const dir = await freshProject();
    const taskId = await seedTask(dir, "uuid-peek", "peek me");
    const slot = await peekArchiveSlot(dir);
    assert.ok(slot !== null);
    assert.equal(slot.status, "in_progress");
    assert.equal(slot.task_id, taskId);
  });
});

describe("archiveAndReset", () => {
  it("archives a terminal slot", async () => {
    const dir = await freshProject();
    const taskId = await seedTask(dir, "uuid-ar-1", "done task");
    await finalize(dir, "accepted");

    const result = await archiveAndReset(dir, NOW);
    assert.equal(result.archived, true);
    assert.equal(result.task_id, taskId);
    assert.equal(existsSync(join(dir, ".loom", "state.db")), false);
  });

  it("refuses an in-progress slot without force (PROJECT_TASK_ACTIVE), leaving the store intact", async () => {
    const dir = await freshProject();
    await seedTask(dir, "uuid-ar-2", "live task");

    await assert.rejects(
      archiveAndReset(dir, NOW),
      (err: unknown) => err instanceof KernelError && err.code === "PROJECT_TASK_ACTIVE",
    );
    // The live run survived the refusal.
    assert.equal(existsSync(join(dir, ".loom", "state.db")), true);
  });

  it("archives an in-progress slot when force is set", async () => {
    const dir = await freshProject();
    await seedTask(dir, "uuid-ar-3", "live task");

    const result = await archiveAndReset(dir, NOW, { force: true });
    assert.equal(result.archived, true);
    assert.equal(existsSync(join(dir, ".loom", "state.db")), false);
  });
});
