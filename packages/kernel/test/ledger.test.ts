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

// ============================================================================
// Eviction — every ledger write co-commits a bounded delete of expired rows
// ============================================================================

// The batch a single write may evict. Mirrors the module-private cap; if the
// constant changes these bounds-assertions are expected to follow.
const EVICTION_BATCH = 64;

// A point after the expired rows' expiry but well before the live rows'.
const EVICT_AT = "2026-06-11T12:00:00.000Z" as NowToken;
const EXPIRED_AT = "2026-06-01T00:00:00.000Z" as NowToken; // < EVICT_AT
const LIVE_UNTIL = "2026-12-31T00:00:00.000Z" as NowToken; // > EVICT_AT + TTL

describe("idempotency ledger — lazy bounded eviction", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-ledger-evict-"));
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

  function seedRow(db: ReturnType<typeof openDb>, key: string, expiresAt: NowToken): void {
    db.prepare(
      "INSERT INTO kernel_idempotency_ledger " +
        "(key, first_seen_ts, last_seen_ts, response_blob, hook_results_json, " +
        " driver_state_id, task_id, now_token, expires_at) " +
        "VALUES (?, ?, ?, NULL, NULL, 'd-1', 't-1', ?, ?)",
    ).run(key, expiresAt, expiresAt, expiresAt, expiresAt);
  }

  function countWhere(db: ReturnType<typeof openDb>, sql: string, ...params: string[]): number {
    const row = db.prepare(sql).get(...params) as { c: number };
    return row.c;
  }

  it("a single write evicts at most one batch of expired rows; live rows are untouched", async () => {
    const db = openDb(dir);
    for (let i = 0; i < 200; i++) seedRow(db, `provider-call:exp-${i}`, EXPIRED_AT);
    for (let i = 0; i < 3; i++) seedRow(db, `agent-result:live-${i}`, LIVE_UNTIL);

    const expiredBefore = countWhere(
      db,
      "SELECT COUNT(*) AS c FROM kernel_idempotency_ledger WHERE expires_at < ?",
      EVICT_AT,
    );
    assert.equal(expiredBefore, 200);

    // One write co-commits one bounded eviction pass.
    await writeLedgerRow(new TransactionImpl(db, EVICT_AT), "agent-result:new-0", {
      driver_state_id: "d-1",
      task_id: "t-1",
      response_blob: null,
    });

    const expiredAfter = countWhere(
      db,
      "SELECT COUNT(*) AS c FROM kernel_idempotency_ledger WHERE expires_at < ?",
      EVICT_AT,
    );
    // Exactly one batch removed — bounded, never the whole backlog at once.
    assert.equal(expiredBefore - expiredAfter, EVICTION_BATCH);

    // Live rows (well inside their TTL) are never candidates.
    const liveCount = countWhere(
      db,
      "SELECT COUNT(*) AS c FROM kernel_idempotency_ledger WHERE key LIKE 'agent-result:live-%'",
    );
    assert.equal(liveCount, 3, "live rows survive eviction");
  });

  it("repeated writes drain the backlog to the live set — commit cost stops scaling with history", async () => {
    const db = openDb(dir);
    for (let i = 0; i < 200; i++) seedRow(db, `provider-call:exp-${i}`, EXPIRED_AT);
    for (let i = 0; i < 3; i++) seedRow(db, `agent-result:live-${i}`, LIVE_UNTIL);

    // ceil(200 / batch) writes fully drain the expired backlog.
    const writes = Math.ceil(200 / EVICTION_BATCH);
    for (let i = 0; i < writes; i++) {
      await writeLedgerRow(new TransactionImpl(db, EVICT_AT), `agent-result:new-${i}`, {
        driver_state_id: "d-1",
        task_id: "t-1",
        response_blob: null,
      });
    }

    const expiredRemaining = countWhere(
      db,
      "SELECT COUNT(*) AS c FROM kernel_idempotency_ledger WHERE expires_at < ?",
      EVICT_AT,
    );
    assert.equal(expiredRemaining, 0, "expired backlog fully drained");

    // What remains is bounded by the live set + the rows these writes added —
    // NOT the 200 rows of history the invariants would otherwise full-scan.
    const total = countWhere(db, "SELECT COUNT(*) AS c FROM kernel_idempotency_ledger");
    assert.equal(total, 3 + writes);
  });

  it("never evicts a row still inside its TTL window", async () => {
    const db = openDb(dir);
    seedRow(db, "agent-result:fresh", LIVE_UNTIL);

    for (let i = 0; i < 5; i++) {
      await writeLedgerRow(new TransactionImpl(db, EVICT_AT), `agent-result:w-${i}`, {
        driver_state_id: "d-1",
        task_id: "t-1",
        response_blob: null,
      });
    }

    const fresh = await readLedgerRow(new TransactionImpl(db, EVICT_AT), "agent-result:fresh");
    assert.ok(fresh !== null, "an unexpired row is never evicted");
  });
});
