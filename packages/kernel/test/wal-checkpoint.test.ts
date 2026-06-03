// WAL-checkpoint mitigation — the schema (and committed rows) must reach the
// main `state.db` file, not stay stranded in an un-checkpointed WAL, so a
// separate process / a fresh connection that reads only the main file sees the
// tables instead of failing with a raw "no such table". A query that still
// hits a missing table surfaces a typed, recoverable error, never a raw fault.
//
// Real SQLite store (temp dir), no mocks: each case copies the main `state.db`
// WITHOUT its `-wal` / `-shm` side-files — exactly what a backup, an archival
// byte-copy, or a fresh process that opened the main file alone would see.

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";

import {
  KernelError,
  closeAll,
  loadState,
  openDb,
  withReadTransaction,
  withStateTransaction,
} from "../src/state.js";
import type { NowToken } from "../src/types/now.js";
import type { Transaction } from "../src/types/transaction.js";

const FIXED_NOW = "2026-06-03T10:00:00.000Z" as NowToken;

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-wal-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    closeAll(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function stateDbPath(dir: string): string {
  return join(dir, ".claude", "state.db");
}

// Open ONLY the main db file (the copy carries no WAL side-file) and report
// whether a kernel table is present — the view a cross-process / fresh opener
// gets of the un-checkpointed store.
function mainFileHasTable(srcDir: string, table: string): boolean {
  const copy = `${stateDbPath(srcDir)}.copy-${table}`;
  copyFileSync(stateDbPath(srcDir), copy);
  const db = new DatabaseSync(copy);
  try {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(table) as { name?: unknown } | undefined;
    return row !== undefined && row.name === table;
  } finally {
    db.close();
    rmSync(copy, { force: true });
  }
}

describe("WAL checkpoint mitigation", () => {
  it("flushes the freshly-created schema into the main file at store creation", () => {
    const dir = freshDir();
    // Construct the pool → migrations run → checkpoint-after-migration fires.
    openDb(dir);
    // A copy of the MAIN file alone (no WAL) must already carry the schema —
    // without the creation-time checkpoint the CREATE TABLE statements stay in
    // the WAL and this copy is an empty header → "no such table".
    assert.equal(mainFileHasTable(dir, "pipeline_state"), true);
  });

  it("flushes committed rows into the main file on close (archival snapshot)", async () => {
    const dir = freshDir();
    await withStateTransaction(dir, FIXED_NOW, async (tx: Transaction) => {
      await tx.exec(
        "INSERT INTO pipeline_state (id, schema_version, project_dir, bundle, " +
          "task_id, task, driver_state_id, status, verdict, started_at, " +
          "gate_policies, decisions) " +
          "VALUES (1, '3.1.0', ?, 'code-fixture', 't-wal-seed', 'seeded', " +
          "'d-wal', 'in_progress', NULL, ?, '{}', '{}')",
        [dir, FIXED_NOW],
      );
      await tx.exec(
        "INSERT INTO driver_state (id, flow_name, step_index, complete, " +
          "pending_user_answer, scratch) VALUES (1, 'standard', 0, 0, NULL, '{}')",
      );
      await tx.exec("INSERT INTO pipeline_counters (id) VALUES (1)");
    });
    // closeAll checkpoints the WAL into the main file before tearing down.
    closeAll(dir);
    const copy = `${stateDbPath(dir)}.snapshot`;
    copyFileSync(stateDbPath(dir), copy);
    const db = new DatabaseSync(copy);
    try {
      const row = db
        .prepare("SELECT task_id FROM pipeline_state WHERE id = 1")
        .get() as { task_id?: unknown } | undefined;
      assert.equal(row?.task_id, "t-wal-seed");
    } finally {
      db.close();
      rmSync(copy, { force: true });
    }
  });

  it("maps a raw 'no such table' to a typed, recoverable error", async () => {
    const dir = freshDir();
    // Bring the store into existence (schema present), then drop the canonical
    // table out from under it to simulate a connection that cannot see the
    // schema. The next read must surface STORE_SCHEMA_MISSING, not the raw
    // backend "no such table: pipeline_state".
    const conn = openDb(dir);
    conn.exec("DROP TABLE pipeline_state");
    await assert.rejects(
      () => withReadTransaction(dir, (tx) => loadState(tx)),
      (err: unknown) => {
        assert.ok(err instanceof KernelError, "expected a KernelError");
        assert.equal(err.code, "STORE_SCHEMA_MISSING");
        assert.equal(err.detail?.["recoverable"], true);
        return true;
      },
    );
  });
});
