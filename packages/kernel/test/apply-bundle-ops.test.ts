import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { applyBundleOps } from "../src/lib/apply-bundle-ops.js";
import { _resetInvariantsForTest } from "../src/invariants.js";
import {
  KernelError,
  captureNow,
  closeDb,
  openDb,
  withStateTransaction,
} from "../src/state.js";
import type { BundleOp } from "../src/types/context.js";
import type { Finding } from "../src/types/findings.js";
import type { NowToken } from "../src/types/now.js";

const NOW = "2026-06-11T10:00:00.000Z" as NowToken;
const DRIVER = "d-bundle-ops";

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "loom-bundle-ops-"));
}

function cleanup(dir: string): void {
  try {
    closeDb(dir);
  } catch {
    /* may already be closed */
  }
  rmSync(dir, { recursive: true, force: true });
}

// Minimal valid canonical rows so a withStateTransaction commit's invariant
// pass (which loads state) is satisfied.
async function seed(dir: string): Promise<void> {
  await withStateTransaction(dir, NOW, async (tx) => {
    await tx.exec(
      "INSERT INTO pipeline_state (id, schema_version, project_dir, bundle, task_id, " +
        "task, driver_state_id, status, verdict, started_at, gate_policies, decisions) " +
        "VALUES (1, '3.0.0', ?, 'fixture', 't-2026-06-11-ops', 'seeded task', ?, " +
        "'in_progress', NULL, ?, '{}', '{}')",
      [dir, DRIVER, NOW],
    );
    await tx.exec(
      "INSERT INTO driver_state (id, flow_name, step_index, complete, pending_user_answer, scratch) " +
        "VALUES (1, 'main', 0, 0, NULL, '{}')",
    );
    await tx.exec("INSERT INTO pipeline_counters (id) VALUES (1)");
    await tx.exec(
      "INSERT INTO phases (name, status, skipped_reason, updated_at) " +
        "VALUES ('p1', 'in_progress', NULL, ?)",
      [NOW],
    );
  });
}

// A bundle-owned table with a declared primary key + two payload columns.
async function createWidgetTable(dir: string): Promise<void> {
  await withStateTransaction(dir, NOW, async (tx) => {
    await tx.exec(
      "CREATE TABLE widgets (id TEXT PRIMARY KEY, label TEXT, count INTEGER)",
    );
  });
}

function finding(id: string, summary = "a finding"): Finding {
  return {
    schema_version: "1.0.0",
    id,
    agent: "logic-reviewer",
    iteration: 1,
    task_id: "t-2026-06-11-ops",
    file: "src/x.ts",
    line_start: 10,
    line_end: 12,
    severity: "warn",
    category: "correctness",
    proposed_new_category: null,
    pattern_id: null,
    summary,
    evidence_excerpt: null,
    suggested_fix: null,
    status: "open",
    ref_rule_id: null,
  };
}

// Force an unparseable blob past the json_valid CHECK the way real tampering
// / backend skew would — the guard under test is the READER, not the
// write-time constraint.
function corruptColumn(dir: string, column: string, blob: string): void {
  const db = openDb(dir);
  db.exec("PRAGMA ignore_check_constraints = ON");
  db.prepare(`UPDATE pipeline_state SET ${column} = ? WHERE id = 1`).run(blob);
  db.exec("PRAGMA ignore_check_constraints = OFF");
}

describe("upsert_bundle_row — column-key validation", () => {
  let dir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    dir = freshProject();
    openDb(dir);
  });
  afterEach(() => cleanup(dir));

  it("rejects a malicious column key without writing or dropping the table", async () => {
    await seed(dir);
    await createWidgetTable(dir);

    const ops: BundleOp[] = [
      {
        op: "upsert_bundle_row",
        table: "widgets",
        // A key shaped to break out of the column list if interpolated raw.
        row: { "id) VALUES ('x'); DROP TABLE widgets; --": "boom" },
      },
    ];
    await assert.rejects(
      withStateTransaction(dir, captureNow(), (tx) => applyBundleOps(tx, ops)),
      (err: unknown) => err instanceof KernelError && err.code === "BUNDLE_COLUMN_INVALID",
    );

    // The table is intact and empty — the injection neither ran nor wrote.
    const db = openDb(dir);
    const tbl = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='widgets'")
      .get() as { name?: string } | undefined;
    assert.equal(tbl?.name, "widgets", "widgets table still exists");
    const cnt = db.prepare("SELECT COUNT(*) AS c FROM widgets").get() as { c: number };
    assert.equal(cnt.c, 0, "no row was written");
  });

  it("rejects a key that is a bare identifier but not a real column", async () => {
    await seed(dir);
    await createWidgetTable(dir);

    const ops: BundleOp[] = [
      { op: "upsert_bundle_row", table: "widgets", row: { id: "w1", nope: 1 } },
    ];
    await assert.rejects(
      withStateTransaction(dir, captureNow(), (tx) => applyBundleOps(tx, ops)),
      (err: unknown) => err instanceof KernelError && err.code === "BUNDLE_COLUMN_INVALID",
    );
  });

  it("refuses an upsert into a table that does not exist", async () => {
    await seed(dir);
    const ops: BundleOp[] = [
      { op: "upsert_bundle_row", table: "ghost_table", row: { id: "w1" } },
    ];
    await assert.rejects(
      withStateTransaction(dir, captureNow(), (tx) => applyBundleOps(tx, ops)),
      (err: unknown) => err instanceof KernelError && err.code === "BUNDLE_TABLE_UNKNOWN",
    );
  });
});

describe("upsert_bundle_row — true UPSERT preserves the row", () => {
  let dir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    dir = freshProject();
    openDb(dir);
  });
  afterEach(() => cleanup(dir));

  it("updates the conflicting row in place (rowid preserved), not delete+insert", async () => {
    await seed(dir);
    await createWidgetTable(dir);

    await withStateTransaction(dir, captureNow(), (tx) =>
      applyBundleOps(tx, [
        { op: "upsert_bundle_row", table: "widgets", row: { id: "w1", label: "first", count: 1 } },
      ]),
    );

    const db = openDb(dir);
    const before = db
      .prepare("SELECT rowid AS rid, label, count FROM widgets WHERE id = 'w1'")
      .get() as { rid: number; label: string; count: number };
    assert.equal(before.label, "first");

    // Upsert the same PK with a changed payload column.
    await withStateTransaction(dir, captureNow(), (tx) =>
      applyBundleOps(tx, [
        { op: "upsert_bundle_row", table: "widgets", row: { id: "w1", label: "second", count: 2 } },
      ]),
    );

    const after = db
      .prepare("SELECT rowid AS rid, label, count FROM widgets WHERE id = 'w1'")
      .get() as { rid: number; label: string; count: number };
    const total = db.prepare("SELECT COUNT(*) AS c FROM widgets").get() as { c: number };

    assert.equal(total.c, 1, "still exactly one row — no delete+insert duplication");
    assert.equal(after.rid, before.rid, "rowid preserved — DO UPDATE, not REPLACE");
    assert.equal(after.label, "second", "non-key column updated");
    assert.equal(after.count, 2);
  });
});

describe("merge helpers — corrupt state fails loud (STATE_CORRUPT)", () => {
  let dir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    dir = freshProject();
    openDb(dir);
  });
  afterEach(() => cleanup(dir));

  it("set_decision on a corrupt decisions blob throws STATE_CORRUPT and rolls back", async () => {
    await seed(dir);
    corruptColumn(dir, "decisions", "not-json{");

    await assert.rejects(
      withStateTransaction(dir, captureNow(), (tx) =>
        applyBundleOps(tx, [{ op: "set_decision", key: "k", value: "v" }]),
      ),
      (err: unknown) => err instanceof KernelError && err.code === "STATE_CORRUPT",
    );

    // The corrupt blob is untouched — NOT silently overwritten with `{k:"v"}`.
    const db = openDb(dir);
    const row = db
      .prepare("SELECT decisions FROM pipeline_state WHERE id = 1")
      .get() as { decisions: string };
    assert.equal(row.decisions, "not-json{");
  });

  it("record_files_modified on a corrupt files_modified blob throws STATE_CORRUPT", async () => {
    await seed(dir);
    corruptColumn(dir, "files_modified", "[oops");

    await assert.rejects(
      withStateTransaction(dir, captureNow(), (tx) =>
        applyBundleOps(tx, [{ op: "record_files_modified", paths: ["a.ts"] }]),
      ),
      (err: unknown) => err instanceof KernelError && err.code === "STATE_CORRUPT",
    );

    const db = openDb(dir);
    const row = db
      .prepare("SELECT files_modified FROM pipeline_state WHERE id = 1")
      .get() as { files_modified: string };
    assert.equal(row.files_modified, "[oops");
  });
});

describe("record_finding — idempotent on the finding id", () => {
  let dir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    dir = freshProject();
    openDb(dir);
  });
  afterEach(() => cleanup(dir));

  it("re-applying the same record_finding op lands one row, not a duplicate", async () => {
    await seed(dir);

    // First application.
    await withStateTransaction(dir, captureNow(), (tx) =>
      applyBundleOps(tx, [{ op: "record_finding", finding: finding("f-2026-06-11-aaaaaa") }], "p1", 1),
    );
    // Re-application of the same op (same id) — the crash-resume / replay case.
    await withStateTransaction(dir, captureNow(), (tx) =>
      applyBundleOps(
        tx,
        [{ op: "record_finding", finding: finding("f-2026-06-11-aaaaaa", "changed text") }],
        "p1",
        1,
      ),
    );

    const db = openDb(dir);
    const cnt = db
      .prepare("SELECT COUNT(*) AS c FROM findings WHERE id = 'f-2026-06-11-aaaaaa'")
      .get() as { c: number };
    assert.equal(cnt.c, 1, "exactly one row — the second insert is a no-op on PK conflict");
    // ON CONFLICT DO NOTHING keeps the FIRST row (does not overwrite).
    const row = db
      .prepare("SELECT summary FROM findings WHERE id = 'f-2026-06-11-aaaaaa'")
      .get() as { summary: string };
    assert.equal(row.summary, "a finding");
  });
});
