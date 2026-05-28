import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { readLedgerRow, writeLedgerRow } from "../src/lib/ledger.js";
import { closeDb, openDb, TransactionImpl } from "../src/state.js";
import type { NowToken } from "../src/types/now.js";

const NOW1 = "2026-05-28T10:00:00.000Z" as NowToken;
const NOW2 = "2026-05-28T11:30:00.000Z" as NowToken;

describe("idempotency ledger reader/writer", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-ledger-"));
    openDb(dir);
  });
  afterEach(() => {
    try {
      closeDb(dir);
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("writeLedgerRow then readLedgerRow round-trips the row", async () => {
    const db = openDb(dir);
    const tx = new TransactionImpl(db, NOW1);
    await writeLedgerRow(tx, "agent-result:ar-1", {
      driver_state_id: "d-1",
      task_id: "t-1",
      response_blob: null,
    });

    const row = await readLedgerRow(tx, "agent-result:ar-1");
    assert.ok(row !== null);
    if (row === null) return;
    assert.equal(row.key, "agent-result:ar-1");
    assert.equal(row.first_seen_ts, NOW1);
    assert.equal(row.last_seen_ts, NOW1);
    assert.equal(row.response_blob, null);
    assert.equal(row.hook_results_json, null);
  });

  it("a second write for the same key bumps last_seen_ts and refreshes the blob", async () => {
    const db = openDb(dir);
    await writeLedgerRow(new TransactionImpl(db, NOW1), "task-create:uuid-1", {
      driver_state_id: "d-1",
      response_blob: null,
    });
    await writeLedgerRow(new TransactionImpl(db, NOW2), "task-create:uuid-1", {
      driver_state_id: "d-1",
      response_blob: JSON.stringify({ status: "complete" }),
    });

    const row = await readLedgerRow(new TransactionImpl(db, NOW2), "task-create:uuid-1");
    assert.ok(row !== null);
    if (row === null) return;
    // first_seen stays anchored to the original write; last_seen advances.
    assert.equal(row.first_seen_ts, NOW1);
    assert.equal(row.last_seen_ts, NOW2);
    assert.equal(row.response_blob, JSON.stringify({ status: "complete" }));
  });

  it("a later write that omits the blob keeps the previously-cached one", async () => {
    const db = openDb(dir);
    await writeLedgerRow(new TransactionImpl(db, NOW1), "agent-result:ar-2", {
      driver_state_id: "d-1",
      response_blob: JSON.stringify({ status: "spawn-agent" }),
    });
    await writeLedgerRow(new TransactionImpl(db, NOW2), "agent-result:ar-2", {
      driver_state_id: "d-1",
    });

    const row = await readLedgerRow(new TransactionImpl(db, NOW2), "agent-result:ar-2");
    assert.ok(row !== null);
    if (row === null) return;
    assert.equal(row.response_blob, JSON.stringify({ status: "spawn-agent" }));
  });

  it("readLedgerRow on an absent key returns null", async () => {
    const db = openDb(dir);
    const row = await readLedgerRow(new TransactionImpl(db, NOW1), "user-answer:never-written");
    assert.equal(row, null);
  });
});
