// SQLite-backed Transaction runtime + the atomic-mutation wrapper.
//
// `TransactionImpl` implements the kernel-internal Transaction interface
// over a node:sqlite DatabaseSync handle. `withStateTransaction` opens
// BEGIN IMMEDIATE, hands the wrapped handle to the caller's fn, runs
// pre-commit hooks (validateState + runInvariants stubs), then commits
// — or rolls back on any throw. STATE_BUSY is translated once at this
// boundary so callers never see a raw driver code.

import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import type { NowToken } from "../types/now.js";
import type { Transaction } from "../types/transaction.js";
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  KernelError,
  openDb,
} from "./db.js";

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

interface Violation {
  code: string;
  message: string;
}

// Pre-commit invariant runner. Bodies of the kernel invariants land in
// a later session; the call site exists so the rollback-on-violation
// path is exercised end-to-end already.
async function runInvariants(_tx: Transaction): Promise<Violation[]> {
  return [];
}

// ============================================================================
// withStateTransaction
// ============================================================================

// Open one atomic SQLite transaction at BEGIN IMMEDIATE, hand a
// Transaction handle to the caller's fn, validate + invariant-check
// before commit, and roll back on any throw.
//
// STATE_BUSY: when the writer lock is held by another connection and
// the busy_timeout expires, SQLite raises a "database is locked" /
// "busy" error at BEGIN; the catch below maps it to a typed
// KernelError so callers never see a raw driver code.
export async function withStateTransaction<T>(
  projectDir: string,
  now: NowToken,
  fn: (tx: Transaction) => Promise<T>,
  opts?: { busyTimeoutMs?: number },
): Promise<T> {
  const db = openDb(projectDir, opts);

  // The default busy_timeout is set on first open; if a caller supplies
  // a value after the first open, re-apply it for this tx and restore
  // the default on the way out (success or failure).
  if (opts?.busyTimeoutMs !== undefined) {
    db.exec(`PRAGMA busy_timeout = ${opts.busyTimeoutMs}`);
  }

  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (err) {
    if (opts?.busyTimeoutMs !== undefined) {
      db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
    }
    const msg = (err as Error).message;
    if (/\bbusy\b|\blocked\b/i.test(msg)) {
      throw new KernelError({ code: "STATE_BUSY", message: msg });
    }
    throw err;
  }

  const tx = new TransactionImpl(db, now);
  try {
    const result = await fn(tx);
    await validateState(tx);
    const violations = await runInvariants(tx);
    if (violations.length > 0) {
      throw new KernelError({
        code: "INVARIANT_VIOLATION",
        detail: { violations: violations as unknown as Record<string, unknown> },
      });
    }
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* tx may already be terminated */ }
    throw err;
  } finally {
    if (opts?.busyTimeoutMs !== undefined) {
      db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
    }
  }
}
