// Per-project SQLite connection pool + migration runner.
//
// Each project's state DB is fronted by a `ConnectionPool`, cached in
// this module's per-project registry. Every kernel operation BORROWS a
// connection for its lifetime and RETURNS it; no two in-flight
// operations ever share a connection. That makes a second
// `BEGIN IMMEDIATE` on an already-open handle ("cannot start a
// transaction within a transaction") impossible by construction —
// intra-process write contention now contends on the SQLite write lock
// exactly like the cross-process case (`BEGIN IMMEDIATE` + busy_timeout
// → typed `STATE_BUSY`). Other state.* modules reach a connection by
// borrowing from the pool, not by importing node:sqlite directly, so the
// backend coupling stays in this one file.
//
// Also home to `KernelError` (the typed error surface every other
// module throws through) and `captureNow()` (the documented mint-time
// clock read that mirrors the exception in ids.ts).

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import type { NowToken } from "../types/now.js";

// ============================================================================
// KernelError
// ============================================================================

// Typed error surface for kernel callers. Codes thrown by this package:
//   STATE_BUSY              writer-lock contention exceeded busy_timeout
//   STATE_CORRUPT           a JSON column failed to parse on read
//   STATE_NOT_INITIALIZED   loadState called before the task-create tx
//   SCHEMA_MIGRATION_FAILED a pending migration file errored mid-apply
//   MIGRATIONS_DIR_NOT_FOUND  packaging layout drifted from expectation
//   INVARIANT_VIOLATION     pre-commit invariants reported violations
export class KernelError extends Error {
  readonly code: string;
  readonly detail?: Record<string, unknown>;
  constructor(opts: { code: string; message?: string; detail?: Record<string, unknown> }) {
    super(opts.message ?? opts.code);
    this.name = "KernelError";
    this.code = opts.code;
    if (opts.detail !== undefined) this.detail = opts.detail;
  }
}

// ============================================================================
// captureNow — documented mint-time clock read
// ============================================================================

// Wall-clock reads are permitted in exactly three places: the id
// generators in ids.ts, the migration runner's applied_at stamp below,
// and this helper. Every other timestamp inside the kernel reads
// `tx.now` (or a NowToken threaded in from the FSM tick boundary).
// The returned token is ISO-8601 UTC by construction and matches the
// NowToken brand.
export function captureNow(): NowToken {
  return new Date().toISOString() as NowToken; // allow-ambient-clock: documented mint-time clock read; every other timestamp reads tx.now
}

// ============================================================================
// Tuning constants
// ============================================================================

export const KERNEL_SCHEMA_VERSION = "3.0.0";
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

// Per-project ceiling on borrowable connections. WAL serializes writers
// regardless, so this only bounds open file descriptors under concurrent
// reads + a writer; a handful is plenty. `acquire()` waits for a release
// once the pool is at the cap.
export const POOL_MAX_CONNECTIONS = 8;

// Cold-start WAL-switch backoff. Two first-opens of the same fresh file
// contend on the brief exclusive lock the journal-mode switch needs, and
// SQLite returns BUSY there WITHOUT honoring busy_timeout. WAL is
// idempotent and the conversion is sub-millisecond, so the loser backs
// off and re-checks: it observes "wal" already set and proceeds.
const WAL_SWITCH_BACKOFF_MS = 10;

// Synchronous backoff that blocks without spinning and reads no clock
// (replay-safe; no Date / Date.now). Used only on the one-time cold-start
// WAL-switch race below.
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function migrationsDir(): string {
  // After tsc, this file lives at <pkg>/dist/src/state/db.js; in dev
  // under <pkg>/src/state/db.ts. Both layouts put the package root
  // three (compiled) or two (source) levels up, where the migrations
  // directory sits.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", "..", "migrations"), // dist/src/state/db.js
    resolve(here, "..", "..", "migrations"),       // src/state/db.ts
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new KernelError({
    code: "MIGRATIONS_DIR_NOT_FOUND",
    message: `tried: ${candidates.join(", ")}`,
  });
}

// ============================================================================
// ConnectionPool — per-project borrow/return free-list
// ============================================================================

export interface PoolStats {
  /** Borrowable connections currently open (free + checked-out). */
  open: number;
  /** Connections sitting idle in the free-list, ready to hand out. */
  free: number;
  /** Connections currently checked out by an in-flight operation. */
  borrowed: number;
  /** Whether the dedicated maintenance connection has been opened. */
  dedicated: boolean;
  /** Callers parked waiting for a connection (pool at cap). */
  waiters: number;
}

class ConnectionPool {
  private readonly dbPath: string;
  private readonly resolvedDir: string;
  private readonly busyTimeoutMs: number;
  private readonly cap: number;

  private readonly free: DatabaseSync[] = [];
  private readonly waiters: Array<(conn: DatabaseSync) => void> = [];
  // Count of borrowable connections that exist (in `free` or checked out).
  private openCount = 0;
  // WAL is a persistent, database-level property — set once on the first
  // connection, never again. busy_timeout / foreign_keys are
  // per-connection and re-applied on every open.
  private walInitialized = false;
  // A single long-lived connection for ad-hoc maintenance reads/seeding
  // (the `openDb` surface). Kept OUT of the borrow rotation so it never
  // collides with an in-flight borrow.
  private dedicated: DatabaseSync | null = null;

  constructor(resolvedDir: string, busyTimeoutMs: number, cap: number) {
    this.resolvedDir = resolvedDir;
    this.busyTimeoutMs = busyTimeoutMs;
    this.cap = cap;

    const claudeDir = join(resolvedDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    this.dbPath = join(claudeDir, "state.db");

    // First connection sets WAL once, then runs migrations under the
    // serialized window. It is parked in the free-list afterwards — a
    // migrated connection is a perfectly good borrowable one.
    const first = this.openConnection();
    runMigrations(first, this.resolvedDir);
    this.free.push(first);
  }

  private openConnection(): DatabaseSync {
    const db = new DatabaseSync(this.dbPath);
    // busy_timeout FIRST so every following statement — including the WAL
    // mode switch and the migration BEGIN IMMEDIATE — waits on a held
    // lock instead of failing instantly. Two cold first-opens of the same
    // fresh file briefly contend on the header write while enabling WAL;
    // without the timeout in place the loser would see a raw
    // "database is locked".
    db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
    if (!this.walInitialized) {
      // WAL — readers never block writers, writers see a consistent
      // pre-commit snapshot, and a read transaction pins one snapshot for
      // its lifetime. Persistent in the DB header, so set once per DB.
      this.enableWal(db);
      this.walInitialized = true;
    }
    // wal_autocheckpoint is a per-connection trigger (any connection can
    // be the committing writer), so carry it on each.
    db.exec("PRAGMA wal_autocheckpoint = 4000");
    db.exec("PRAGMA foreign_keys = ON");
    this.openCount += 1;
    return db;
  }

  // Switch to WAL, tolerating the cold-start race where two first-opens
  // of the same fresh file collide on the journal-mode exclusive lock.
  // Read the current mode first (the common path once any opener has won
  // is a no-op skip); on a BUSY/locked switch, back off and retry until
  // the busy_timeout budget is spent — by then a peer has set WAL and the
  // re-read short-circuits.
  private enableWal(db: DatabaseSync): void {
    const deadlineAttempts = Math.max(1, Math.ceil(this.busyTimeoutMs / WAL_SWITCH_BACKOFF_MS));
    let lastErr: unknown;
    for (let attempt = 0; attempt < deadlineAttempts; attempt += 1) {
      try {
        const current = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
        if (current?.journal_mode === "wal") return;
        const set = db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode?: string } | undefined;
        if (set?.journal_mode === "wal") return;
        lastErr = new Error(`journal_mode stayed '${set?.journal_mode ?? "unknown"}'`);
      } catch (err) {
        if (!/\bbusy\b|\blocked\b/i.test((err as Error).message)) throw err;
        lastErr = err;
      }
      sleepMs(WAL_SWITCH_BACKOFF_MS);
    }
    throw new KernelError({
      code: "STATE_BUSY",
      message: `enabling WAL: ${(lastErr as Error | undefined)?.message ?? "contended"}`,
    });
  }

  // Borrow a connection for the lifetime of one operation. Free-list hit
  // first; else open a fresh one up to the cap; else wait for a release.
  async acquire(): Promise<DatabaseSync> {
    const reused = this.free.pop();
    if (reused !== undefined) return reused;
    if (this.openCount < this.cap) return this.openConnection();
    return await new Promise<DatabaseSync>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  // Return a CLEAN connection to the pool (never closes it). The caller
  // MUST have ended any transaction first; release defensively resets the
  // per-connection knobs a borrow may have changed (query_only, a
  // per-call busy_timeout) so the next borrower starts from the default.
  release(conn: DatabaseSync): void {
    try {
      conn.exec("PRAGMA query_only = OFF");
      conn.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
    } catch {
      // A connection that refuses a bare PRAGMA is unusable — drop it
      // rather than hand a broken handle to the next borrower.
      this.discard(conn);
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(conn);
      return;
    }
    this.free.push(conn);
  }

  // Close a poisoned connection (e.g. a ROLLBACK itself threw, so its
  // transaction state is unknown). Keeps the pool live for any waiter by
  // opening a replacement.
  discard(conn: DatabaseSync): void {
    try { conn.close(); } catch { /* may already be closed */ }
    this.openCount -= 1;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter(this.openConnection());
  }

  // Lazily open the dedicated maintenance connection for `openDb`.
  directConnection(): DatabaseSync {
    if (this.dedicated === null) this.dedicated = this.openConnection();
    return this.dedicated;
  }

  // Close every connection this pool owns. A teardown hook — callers must
  // not have borrows in flight.
  closeAll(): void {
    for (const c of this.free) {
      try { c.close(); } catch { /* may already be closed */ }
    }
    this.free.length = 0;
    if (this.dedicated !== null) {
      try { this.dedicated.close(); } catch { /* may already be closed */ }
      this.dedicated = null;
    }
    this.waiters.length = 0;
    this.openCount = 0;
  }

  stats(): PoolStats {
    return {
      open: this.openCount,
      free: this.free.length,
      borrowed: this.openCount - this.free.length,
      dedicated: this.dedicated !== null,
      waiters: this.waiters.length,
    };
  }
}

// ============================================================================
// Per-project pool registry
// ============================================================================

const poolRegistry = new Map<string, ConnectionPool>();

// Process-level applied-set: paths whose migrations have run in this
// process. Combined with the synchronous per-path pool construction
// below, two in-process first-opens can never both enter the apply
// window. (Cross-process first-opens are serialized by the migration
// runner's in-lock version re-check.)
const migratedPaths = new Set<string>();

// Resolve (creating + migrating on first touch) the pool for a project.
// Construction is synchronous through the migration apply, so the
// registry itself serializes concurrent in-process first-opens.
//
// `busyTimeoutMs` is honored only on the first construction for a given
// projectDir; tests that need a low value to exercise STATE_BUSY should
// pass a fresh tempdir per case.
export function getPool(projectDir: string, opts?: { busyTimeoutMs?: number }): ConnectionPool {
  const resolved = resolve(projectDir);
  const cached = poolRegistry.get(resolved);
  if (cached !== undefined) return cached;
  const pool = new ConnectionPool(
    resolved,
    opts?.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    POOL_MAX_CONNECTIONS,
  );
  poolRegistry.set(resolved, pool);
  return pool;
}

// Borrow a connection for the duration of `fn`, then return it. On
// success the connection is released back to the pool; on throw it is
// discarded (a thrown error may have left a transaction open, so the
// handle is treated as poisoned). For multi-transaction operations that
// need a raw handle but must not pin the shared maintenance connection.
export async function withConnection<T>(
  projectDir: string,
  fn: (db: DatabaseSync) => Promise<T>,
): Promise<T> {
  const pool = getPool(projectDir);
  const conn = await pool.acquire();
  try {
    const result = await fn(conn);
    pool.release(conn);
    return result;
  } catch (err) {
    pool.discard(conn);
    throw err;
  }
}

// Open (or return) the project's dedicated maintenance connection. This
// is NOT the handle kernel transactions run on — `withStateTransaction`
// and `withReadTransaction` borrow their own pooled connections. The
// dedicated connection backs ad-hoc single-statement reads and test
// seeding, where no transaction is held across an await.
export function openDb(projectDir: string, opts?: { busyTimeoutMs?: number }): DatabaseSync {
  return getPool(projectDir, opts).directConnection();
}

// Close a project's pool (every connection it owns) and forget it, so the
// next access re-enters construction + the migration runner. Primarily a
// test/teardown hook; safe to call when no pool exists.
export function closeAll(projectDir?: string): void {
  if (projectDir === undefined) {
    for (const pool of poolRegistry.values()) pool.closeAll();
    poolRegistry.clear();
    migratedPaths.clear();
    return;
  }
  const resolved = resolve(projectDir);
  const pool = poolRegistry.get(resolved);
  if (pool !== undefined) {
    pool.closeAll();
    poolRegistry.delete(resolved);
  }
  migratedPaths.delete(resolved);
}

// Back-compat alias for the prior per-project test hook.
export function closeDb(projectDir: string): void {
  closeAll(projectDir);
}

// Introspection for tests (connection reuse / fd-leak assertions). Not
// re-exported from the package barrel — kernel-internal only.
export function poolStats(projectDir: string): PoolStats | null {
  const pool = poolRegistry.get(resolve(projectDir));
  return pool === undefined ? null : pool.stats();
}

// ============================================================================
// Migration runner
// ============================================================================

// Applies every `<seq>-<name>.sql` file under packages/kernel/migrations
// that has not yet been recorded in `kernel_schema_versions`. The whole
// apply pass runs inside one BEGIN IMMEDIATE, and the applied-version set
// is read INSIDE that lock: a second first-open of the same fresh DB
// (another connection, or another process) blocks on the lock, re-reads
// the version rows once it has it, finds them present, and no-ops —
// instead of re-running the CREATE TABLE statements and hard-failing on
// "table already exists". Re-running against a current DB is a no-op.
function runMigrations(db: DatabaseSync, resolvedDir: string): void {
  if (migratedPaths.has(resolvedDir)) return;

  const dir = migrationsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  let failingFile: string | undefined;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS kernel_schema_versions (
      component TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);

    const seen = new Set<string>();
    for (const row of db.prepare("SELECT component FROM kernel_schema_versions").all()) {
      seen.add(String((row as { component: unknown }).component));
    }

    for (const file of files) {
      const component = file.replace(/\.sql$/, "");
      if (seen.has(component)) continue;
      failingFile = file;
      const sql = readFileSync(join(dir, file), "utf8");
      db.exec(sql);
      // Migration apply runs at process start, before any FSM tick has
      // captured a NowToken — the applied_at stamp is documented as an
      // ambient-clock allowance alongside captureNow() and ids.ts.
      const appliedAt = new Date().toISOString(); // allow-ambient-clock: migration apply runs before any FSM tick has captured a NowToken
      db.prepare("INSERT INTO kernel_schema_versions VALUES (?, ?, ?)").run(
        component,
        KERNEL_SCHEMA_VERSION,
        appliedAt,
      );
    }

    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* tx may already be terminated */ }
    const msg = (err as Error).message;
    if (/\bbusy\b|\blocked\b/i.test(msg)) {
      throw new KernelError({ code: "STATE_BUSY", message: msg });
    }
    throw new KernelError({
      code: "SCHEMA_MIGRATION_FAILED",
      message: failingFile === undefined ? msg : `migration ${failingFile}: ${msg}`,
      ...(failingFile === undefined ? {} : { detail: { file: failingFile } }),
    });
  }

  migratedPaths.add(resolvedDir);
}
