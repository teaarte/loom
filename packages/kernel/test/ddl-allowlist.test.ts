import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { KernelError } from "../src/state/db.js";
import { parseRestoreSql } from "../src/lib/ddl-allowlist.js";

function expectRejected(sql: string): KernelError {
  try {
    parseRestoreSql(sql);
  } catch (err) {
    assert.ok(err instanceof KernelError, "expected a KernelError");
    assert.equal(err.code, "RESTORE_REJECTED");
    return err;
  }
  throw new Error(`expected RESTORE_REJECTED for: ${sql}`);
}

describe("parseRestoreSql", () => {
  it("accepts the allowed statement set", () => {
    const sql = [
      "PRAGMA journal_mode=WAL;",
      "PRAGMA wal_autocheckpoint=4000;",
      "CREATE TABLE IF NOT EXISTS pipeline_state (id INTEGER PRIMARY KEY CHECK (id = 1));",
      "CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);",
      "INSERT INTO phases (name, status, updated_at) VALUES ('work', 'pending', '2026-05-29T12:00:00.000Z');",
    ].join("\n");
    const out = parseRestoreSql(sql);
    assert.equal(out.length, 5);
  });

  it("accepts CREATE TABLE / INSERT for the bypass_markers kernel table", () => {
    const sql = [
      "CREATE TABLE IF NOT EXISTS bypass_markers (id INTEGER PRIMARY KEY CHECK (id = 1), issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, reason TEXT NOT NULL, hmac TEXT NOT NULL, key_id TEXT NOT NULL);",
      "INSERT INTO bypass_markers (id, issued_at, expires_at, reason, hmac, key_id) VALUES (1, '2026-05-29T12:00:00.000Z', '2026-05-29T13:00:00.000Z', 'cross-owner-recover:d-x', 'abc', 'env:dead');",
    ].join("\n");
    const out = parseRestoreSql(sql);
    assert.equal(out.length, 2);
  });

  it("refuses ATTACH", () => {
    expectRejected("ATTACH DATABASE 'evil.db' AS evil;");
  });

  it("refuses load_extension", () => {
    expectRejected("SELECT load_extension('evil.so');");
  });

  it("refuses DROP", () => {
    expectRejected("DROP TABLE pipeline_state;");
  });

  it("refuses bare UPDATE", () => {
    expectRejected("UPDATE pipeline_state SET status = 'completed' WHERE id = 1;");
  });

  it("refuses bare DELETE", () => {
    expectRejected("DELETE FROM audit;");
  });

  it("refuses ALTER", () => {
    expectRejected("ALTER TABLE pipeline_state ADD COLUMN evil TEXT;");
  });

  it("refuses PRAGMA foreign_keys=OFF", () => {
    expectRejected("PRAGMA foreign_keys=OFF;");
  });

  it("refuses PRAGMA locking_mode", () => {
    expectRejected("PRAGMA locking_mode=EXCLUSIVE;");
  });

  it("refuses a host-clock function inside an otherwise-allowed INSERT", () => {
    const err = expectRejected(
      "INSERT INTO audit (ts, type) VALUES (datetime('now'), 'recovery');",
    );
    assert.match(err.message, /host-clock/);
  });

  it("refuses an INSERT into a non-kernel table", () => {
    const err = expectRejected("INSERT INTO secret_table (a) VALUES (1);");
    assert.match(err.message, /non-kernel table/);
  });

  it("refuses a CREATE TABLE for a non-kernel table", () => {
    expectRejected("CREATE TABLE secret_table (a TEXT);");
  });

  it("splits a string containing an embedded semicolon correctly", () => {
    // The ';' lives inside the quoted value — the splitter must not break
    // the statement there, and the single allowed INSERT must survive.
    const sql =
      "INSERT INTO findings (id, summary) VALUES ('f-1', 'a; b; c');\n" +
      "INSERT INTO findings (id, summary) VALUES ('f-2', 'plain');";
    const out = parseRestoreSql(sql);
    assert.equal(out.length, 2);
    assert.match(out[0] as string, /a; b; c/);
  });

  it("names the offending statement in the refusal", () => {
    const err = expectRejected("DROP TABLE audit;");
    assert.equal(err.detail?.["statement"], "DROP TABLE audit");
  });
});
