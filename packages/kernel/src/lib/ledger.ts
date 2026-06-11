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
import type { NowToken } from "../types/now.js";
import type { Transaction } from "../types/transaction.js";
import { offsetNowToken } from "./now-arith.js";
import { LEDGER_COLUMNS, mapLedgerRow, type LedgerRow } from "./row-mappers.js";

// 24h per-entry TTL. Each row carries its own expiry from first sight;
// once a row is past it (a full TTL after the op it guarded completed and
// its pending/working rows drained), the dedup window is closed and the
// row is evictable — see `evictExpiredLedger`.
const LEDGER_TTL_MS = 24 * 60 * 60 * 1000;

// Rows a single write-tx may evict. Eviction is LAZY — each ledger write
// removes up to this many already-expired rows — so a commit never pays
// O(table): the delete is bounded here and index-driven (the
// `expires_at` index), while steady-state writes keep the live set small.
// A long quiet spell that piled up expired rows drains over the next few
// writes rather than in one unbounded sweep.
const LEDGER_EVICTION_BATCH = 64;

// The single home for a ledger row's expiry. Every ledger writer — this
// module AND the hook-runner's direct INSERT — derives `expires_at` from
// here so a row's dedup window is uniform: lazy eviction can then treat
// every row by the one rule (`expires_at < tx.now` → evictable) without a
// class of rows born already-expired (and so deleted on the next write,
// dropping a dedup marker still inside its intended window).
export function ledgerExpiresAt(now: NowToken): NowToken {
  return offsetNowToken(now, LEDGER_TTL_MS);
}

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
  const expiresAt = ledgerExpiresAt(now);
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
  // Co-commit a bounded eviction of expired rows with this write so the
  // ledger — and the per-commit cost of the invariants that scan it —
  // stays bounded by the live set rather than all of history.
  await evictExpiredLedger(tx);
}

// Delete a bounded batch of EXPIRED ledger rows (expires_at strictly
// before `tx.now`) inside the caller's write tx — co-committed with
// whatever else that tx is doing. An expired row is past its dedup TTL:
// the op it guarded completed a full TTL ago and its pending/working rows
// are long drained, so removing the marker cannot resurrect an in-flight
// dedup (an unexpired row — anything still inside its window — is never
// touched). The `key IN (SELECT ... ORDER BY expires_at LIMIT batch)`
// shape caps the delete at `batch` rows and rides the `expires_at` index,
// so the work is bounded regardless of how many rows have expired.
// Deterministic over (`tx.now`, the expired set) via the ORDER BY, and it
// reads `tx.now` — never the host clock — so a replay evicts the same set.
async function evictExpiredLedger(tx: Transaction): Promise<void> {
  await tx.exec(
    "DELETE FROM kernel_idempotency_ledger WHERE key IN (" +
      "SELECT key FROM kernel_idempotency_ledger WHERE expires_at < ? " +
      "ORDER BY expires_at ASC LIMIT ?)",
    [tx.now, LEDGER_EVICTION_BATCH],
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
