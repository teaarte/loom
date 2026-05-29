import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { applyRestoreStatements, dumpStateSql } from "../src/lib/backup.js";
import { parseRestoreSql } from "../src/lib/ddl-allowlist.js";
import { reconcileExtensions, type DiscoveredManifest } from "../src/extension-loader.js";
import { initializeTask } from "../src/lib/initialize-task.js";
import { closeDb, loadState, openDb, withStateTransaction } from "../src/state.js";
import type { NowToken } from "../src/types/now.js";

const NOW = "2026-05-29T12:00:00.000Z" as NowToken;

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

async function freshProject(seedBundle: boolean): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "loom-backup-"));
  dirs.push(dir);
  openDb(dir);
  const manifests = seedBundle ? [bundleManifest("code-fixture")] : [];
  await reconcileExtensions({ manifests, project_dir: dir, now: NOW });
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      closeDb(dir);
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("dumpStateSql / applyRestoreStatements", () => {
  it("round-trips a seeded state into a fresh project", async () => {
    const source = await freshProject(true);
    const sourceIds = await withStateTransaction(source, NOW, (tx) =>
      initializeTask(tx, {
        project_dir: source,
        task: "back me up",
        client_idempotency_uuid: "uuid-backup-1",
        phases: ["context", "work"],
      }),
    );

    const dump = await withStateTransaction(source, NOW, (tx) => dumpStateSql(tx));
    assert.ok(dump.length > 0);

    // Restore into a fresh (migrated, empty) project — no bundle seeded.
    const target = await freshProject(false);
    const statements = parseRestoreSql(dump);
    await withStateTransaction(target, NOW, (tx) =>
      applyRestoreStatements(tx, statements),
    );

    const restored = await withStateTransaction(target, NOW, loadState);
    assert.equal(restored.task_id, sourceIds.task_id);
    assert.equal(restored.driver_state_id, sourceIds.driver_state_id);
    assert.equal(restored.task, "back me up");
    assert.equal(restored.status, "in_progress");
    assert.equal(restored.started_at, NOW);
    assert.deepEqual(
      restored.phases.map((p) => [p.name, p.status]),
      [["context", "pending"], ["work", "pending"]],
    );
  });

  it("round-trips values containing single quotes (SQL-literal escaping)", async () => {
    const source = await freshProject(true);
    const quoted = "fix O'Brien's 'quoted'; DROP injection";
    await withStateTransaction(source, NOW, (tx) =>
      initializeTask(tx, {
        project_dir: source,
        task: quoted,
        client_idempotency_uuid: "uuid-backup-quote",
        phases: ["work"],
      }),
    );
    const dump = await withStateTransaction(source, NOW, (tx) => dumpStateSql(tx));

    const target = await freshProject(false);
    const statements = parseRestoreSql(dump);
    await withStateTransaction(target, NOW, (tx) => applyRestoreStatements(tx, statements));

    const restored = await withStateTransaction(target, NOW, loadState);
    // The quote-laden value survived dump (`''` escaping) → split
    // (string-aware) → apply verbatim. The embedded "; DROP" inside the
    // literal must NOT have split into a second statement.
    assert.equal(restored.task, quoted);
  });

  it("emits the journal-mode PRAGMAs in the dump header", async () => {
    const source = await freshProject(true);
    await withStateTransaction(source, NOW, (tx) =>
      initializeTask(tx, {
        project_dir: source,
        task: "wal header",
        client_idempotency_uuid: "uuid-backup-wal",
        phases: ["work"],
      }),
    );
    const dump = await withStateTransaction(source, NOW, (tx) => dumpStateSql(tx));
    const lines = dump.split("\n");
    // The two PRAGMAs lead the dump, before any CREATE/INSERT, so an
    // external tool replaying the .sql at top level sets WAL first.
    assert.equal(lines[0], "PRAGMA journal_mode=WAL;");
    assert.equal(lines[1], "PRAGMA wal_autocheckpoint=4000;");
    const firstCreate = lines.findIndex((l) => l.startsWith("CREATE TABLE"));
    assert.ok(firstCreate > 1);
  });

  it("round-trips a bypass_markers row with hmac + key_id intact", async () => {
    const source = await freshProject(true);
    await withStateTransaction(source, NOW, (tx) =>
      initializeTask(tx, {
        project_dir: source,
        task: "marker backup",
        client_idempotency_uuid: "uuid-backup-marker",
        phases: ["work"],
      }),
    );
    // Seed a marker row directly — backup must carry hmac + key_id so a
    // restore against a rotated key is correctly invalid (intended
    // TTL/rotation semantics, not a dropped field).
    await withStateTransaction(source, NOW, (tx) =>
      tx.exec(
        "INSERT INTO bypass_markers (id, issued_at, expires_at, reason, hmac, key_id) " +
          "VALUES (1, ?, ?, ?, ?, ?)",
        [NOW, "2026-05-29T13:00:00.000Z", "cross-owner-recover:d-x", "abc123def", "env:deadbeef"],
      ),
    );

    const dump = await withStateTransaction(source, NOW, (tx) => dumpStateSql(tx));
    assert.match(dump, /INSERT INTO bypass_markers/);

    const target = await freshProject(false);
    const statements = parseRestoreSql(dump);
    await withStateTransaction(target, NOW, (tx) => applyRestoreStatements(tx, statements));

    const row = await withStateTransaction(target, NOW, (tx) =>
      tx.queryRow<{ hmac: string; key_id: string; reason: string }>(
        "SELECT hmac, key_id, reason FROM bypass_markers WHERE id = 1",
      ),
    );
    assert.ok(row !== null);
    assert.equal(row.hmac, "abc123def");
    assert.equal(row.key_id, "env:deadbeef");
    assert.equal(row.reason, "cross-owner-recover:d-x");
  });

  it("produces a byte-identical dump for the same state", async () => {
    const source = await freshProject(true);
    await withStateTransaction(source, NOW, (tx) =>
      initializeTask(tx, {
        project_dir: source,
        task: "determinism",
        client_idempotency_uuid: "uuid-backup-2",
        phases: ["work"],
      }),
    );
    const first = await withStateTransaction(source, NOW, (tx) => dumpStateSql(tx));
    const second = await withStateTransaction(source, NOW, (tx) => dumpStateSql(tx));
    assert.equal(first, second);
  });
});
