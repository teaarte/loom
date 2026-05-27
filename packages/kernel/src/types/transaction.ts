// Kernel-internal SQLite transaction handle + audit row.
//
// `Transaction` wraps `node:sqlite` Database with the kernel's
// atomic-mutation contract. This type is exported from `@loom/kernel`
// but is NOT part of the plugin API — bundle code receives a
// `BundleScratchTx` façade instead. Static load-time check refuses to
// register a bundle whose source imports the raw `Transaction` type.
//
// `now` is the NowToken captured at FSM-tick entry (outside the tx).
// Kernel functions inside this tx MUST read timestamps from `tx.now`
// (or threaded NowToken parameters) and MUST NOT call `Date.now()` /
// `new Date()`. Replay re-supplies the same token from the
// idempotency-ledger row, making tx-internal computation bit-identical.

import type { NowToken } from "./now.js";

export interface Transaction {
  exec(sql: string, params?: unknown[]): Promise<void>;
  queryRow<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  queryAll<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  audit_buffer: Record<string, unknown>[];
  readonly now: NowToken;
}

// One row in the audit stream. Full schema lives alongside the SQL
// table definition; any change here must mirror that schema.
export interface AuditEntry {
  id: number;
  ts: string;
  type: string;
  task_id: string | null;
  driver_state_id: string | null;
  payload: Record<string, unknown>;
  verdict: "ok" | "error" | "force_bypass";
  error_class: string | null;
}
