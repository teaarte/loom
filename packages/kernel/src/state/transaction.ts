// SQLite-backed Transaction runtime + the atomic-mutation wrappers.
//
// `TransactionImpl` implements the kernel-internal Transaction interface
// over a node:sqlite DatabaseSync handle. `withStateTransaction` borrows
// a connection from the project's pool, opens BEGIN IMMEDIATE, hands the
// wrapped handle to the caller's fn, runs pre-commit hooks (validateState
// + runInvariants), then commits — or rolls back on any throw — and
// returns the connection to the pool. `withReadTransaction` borrows a
// connection, pins one consistent committed snapshot under
// `PRAGMA query_only` + BEGIN DEFERRED, and runs a read-only fn. Each
// operation has its own connection, so two concurrent same-project ticks
// can never re-enter a transaction on a shared handle; write contention
// surfaces through the SQLite write lock as a typed STATE_BUSY, exactly
// like the cross-process case.

import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { runInvariants } from "../invariants.js";
import type { Invariant } from "../types/invariants.js";
import type { NowToken } from "../types/now.js";
import type { Transaction } from "../types/transaction.js";
import { captureNow, getPool, KernelError, mapMissingSchemaError } from "./db.js";

// ============================================================================
// Transaction runtime
// ============================================================================

export class TransactionImpl implements Transaction {
  readonly now: NowToken;
  audit_buffer: Record<string, unknown>[] = [];
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, now: NowToken) {
    this.db = db;
    this.now = now;
  }

  async exec(sql: string, params?: unknown[]): Promise<void> {
    if (params !== undefined && params.length > 0) {
      this.db.prepare(sql).run(...toBindings(params));
    } else {
      this.db.exec(sql);
    }
  }

  async queryRow<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T | null> {
    const stmt = this.db.prepare(sql);
    const row =
      params !== undefined && params.length > 0
        ? stmt.get(...toBindings(params))
        : stmt.get();
    return (row ?? null) as T | null;
  }

  async queryAll<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    const rows =
      params !== undefined && params.length > 0
        ? stmt.all(...toBindings(params))
        : stmt.all();
    return rows as T[];
  }
}

function toBindings(params: unknown[]): SQLInputValue[] {
  // node:sqlite accepts null / number / bigint / string / ArrayBufferView.
  // Booleans coerce to 0/1; everything else passes through. Mistyped
  // bindings would otherwise surface as opaque "data type mismatch"
  // errors at run time — the coercion stays narrow on purpose.
  return params.map((v) => {
    if (typeof v === "boolean") return v ? 1 : 0;
    return v as SQLInputValue;
  });
}

// ============================================================================
// Pre-commit hooks (stubs)
// ============================================================================

// JSON-shape validation. The SQL-level json_valid CHECKs already refuse
// malformed JSON; the JS-side hook stays wired so a later session can
// plug in a precompiled schema registry without re-shaping the public
// surface.
async function validateState(_tx: Transaction): Promise<void> {
  // intentionally empty
}

function isBusyError(err: unknown): boolean {
  return /\bbusy\b|\blocked\b/i.test((err as Error).message);
}

// ============================================================================
// withStateTransaction
// ============================================================================

// Borrow a pooled connection, open one atomic SQLite transaction at
// BEGIN IMMEDIATE, hand a Transaction handle to the caller's fn, validate
// + invariant-check before commit, and roll back on any throw. The
// connection is released back to the pool on the way out — or DISCARDED
// when the ROLLBACK itself throws (the transaction state is then unknown,
// so the handle is poisoned and must not be reused).
//
// STATE_BUSY: when the writer lock is held by another connection (another
// in-process operation OR another process) and busy_timeout expires,
// SQLite raises a "database is locked" / "busy" error at BEGIN; the catch
// maps it to a typed KernelError so callers never see a raw driver code.
export async function withStateTransaction<T>(
  projectDir: string,
  now: NowToken,
  fn: (tx: Transaction) => Promise<T>,
  opts?: { busyTimeoutMs?: number; invariants?: readonly Invariant[] },
): Promise<T> {
  const pool = getPool(projectDir, opts);
  const db = await pool.acquire();

  // A per-call busy_timeout overrides the connection default for this
  // operation; release() restores the pool default before the next
  // borrower sees the connection.
  if (opts?.busyTimeoutMs !== undefined) {
    db.exec(`PRAGMA busy_timeout = ${opts.busyTimeoutMs}`);
  }

  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (err) {
    // BEGIN failed → no transaction was opened → the connection is clean
    // and can be returned for reuse.
    pool.release(db);
    if (isBusyError(err)) {
      throw new KernelError({ code: "STATE_BUSY", message: (err as Error).message });
    }
    throw err;
  }

  const tx = new TransactionImpl(db, now);
  try {
    const result = await fn(tx);
    await validateState(tx);
    // Bundle invariants are threaded per-call (the active registry's set) so
    // the running bundle's rules — its safety floor included — veto this
    // commit alongside the kernel-generic invariants. Absent (utility txs
    // that hold no registry) → kernel-only, as before.
    const violations = await runInvariants(tx, opts?.invariants);
    if (violations.length > 0) {
      throw new KernelError({
        code: "INVARIANT_VIOLATION",
        detail: { violations: violations as unknown as Record<string, unknown> },
      });
    }
    db.exec("COMMIT");
    pool.release(db);
    return result;
  } catch (err) {
    let poisoned = false;
    try { db.exec("ROLLBACK"); } catch { poisoned = true; }
    if (poisoned) pool.discard(db);
    else pool.release(db);
    // A "no such table" here means the schema is not visible on this
    // connection (un-checkpointed WAL / a store opened while empty). Surface
    // it as a typed, recoverable error instead of a raw backend fault.
    throw mapMissingSchemaError(err) ?? err;
  }
}

// ============================================================================
// withReadTransaction
// ============================================================================

// Borrow a pooled connection, pin one consistent committed snapshot under
// `PRAGMA query_only = ON` + BEGIN DEFERRED, run the read-only fn (e.g.
// all of loadState), then COMMIT and return the connection. WAL lets the
// read run concurrently with a writer; the snapshot is fixed at the first
// statement, so a multi-statement read never sees a torn mix across an
// interleaved commit. query_only refuses any accidental write at the
// SQLite layer. The now token threaded through the Transaction is local
// to this read (nothing is persisted), so a fresh captureNow() is fine.
export async function withReadTransaction<T>(
  projectDir: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const pool = getPool(projectDir);
  const db = await pool.acquire();

  try {
    db.exec("PRAGMA query_only = ON");
    db.exec("BEGIN DEFERRED");
  } catch (err) {
    // query_only may have flipped before BEGIN failed → discard so the
    // next borrower never inherits a half-configured handle.
    pool.discard(db);
    if (isBusyError(err)) {
      throw new KernelError({ code: "STATE_BUSY", message: (err as Error).message });
    }
    throw err;
  }

  const tx = new TransactionImpl(db, captureNow());
  try {
    const result = await fn(tx);
    db.exec("COMMIT");
    pool.release(db);
    return result;
  } catch (err) {
    let poisoned = false;
    try { db.exec("ROLLBACK"); } catch { poisoned = true; }
    if (poisoned) pool.discard(db);
    else pool.release(db);
    // Same schema-missing mapping as the write path: a read that hits "no
    // such table" gets the typed, recoverable error, never a raw fault.
    throw mapMissingSchemaError(err) ?? err;
  }
}
