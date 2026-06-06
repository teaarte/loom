// Idempotency-ledger reader + writer — the one place the retryable
// kernel ops (`task-create`, `agent-result`, `user-answer`, and the
// recovery / backup ops that land later) read and write a ledger row.
//
// The two-phase write pattern lives here: a delivery writes its row
// with `response_blob = null` INSIDE the same tx as the state mutation
// it dedupes (row-exists-or-doesn't is atomic with the effect), then a
// follow-up `writeLedgerRow` with the shaped wire envelope materializes
// the cached response. A repeat write for the same key bumps
// `last_seen_ts` and refreshes the blob; `COALESCE` keeps a
// previously-cached blob when the caller passes nothing.
//
// Wall-clock discipline: every timestamp comes from `tx.now`. The TTL expiry
// is derived with `offsetNowToken` (the single NowToken-arithmetic home), which
// parses the supplied token string — it never reads the host clock.

import type { IdempotencyKey, IdempotencyLedgerEntry } from "../types/idempotency.js";
import type { Transaction } from "../types/transaction.js";
import { offsetNowToken } from "./now-arith.js";
import { LEDGER_COLUMNS, mapLedgerRow, type LedgerRow } from "./row-mappers.js";

// 24h per-entry TTL. The replay-after-TTL and eviction passes that act
// on this value land with the recovery surface; the column is written
// here so each row carries its own expiry from first sight.
const LEDGER_TTL_MS = 24 * 60 * 60 * 1000;

export interface WriteLedgerRowOptions {
  // Every ledger row binds to the driver state it was written under so a
  // replay against a fresh task is refusable downstream.
  driver_state_id: string;
  // Null only for the `task-create` row that mints the task_id; every
  // later op binds its row to the task.
  task_id?: string | null;
  // JSON-encoded wire envelope (or provider result). Null on the first
  // "accepted" marker write; the follow-up write supplies it.
  response_blob?: string | null;
  hook_results_json?: string | null;
}

export async function writeLedgerRow(
  tx: Transaction,
  key: IdempotencyKey | string,
  opts: WriteLedgerRowOptions,
): Promise<void> {
  const now = tx.now;
  const expiresAt = offsetNowToken(now, LEDGER_TTL_MS);
  await tx.exec(
    "INSERT INTO kernel_idempotency_ledger " +
      "(key, first_seen_ts, last_seen_ts, response_blob, hook_results_json, " +
      " driver_state_id, task_id, now_token, expires_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET " +
      "last_seen_ts = excluded.last_seen_ts, " +
      "response_blob = COALESCE(excluded.response_blob, kernel_idempotency_ledger.response_blob), " +
      "hook_results_json = COALESCE(excluded.hook_results_json, kernel_idempotency_ledger.hook_results_json)",
    [
      key,
      now,
      now,
      opts.response_blob ?? null,
      opts.hook_results_json ?? null,
      opts.driver_state_id,
      opts.task_id ?? null,
      now,
      expiresAt,
    ],
  );
}

export async function readLedgerRow(
  tx: Transaction,
  key: IdempotencyKey | string,
): Promise<IdempotencyLedgerEntry | null> {
  const row = await tx.queryRow<LedgerRow>(
    `SELECT ${LEDGER_COLUMNS} FROM kernel_idempotency_ledger WHERE key = ?`,
    [key],
  );
  if (row === null) return null;
  return mapLedgerRow(row);
}
