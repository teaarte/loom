// Per-project SQLite Database opener + migration runner.
//
// One DatabaseSync instance per `projectDir`, cached in this module's
// singleton registry; the first call applies pending migrations and
// pins the connection's PRAGMAs (WAL, foreign keys, busy_timeout) for
// the lifetime of the process. Other state.* modules reach the
// connection by calling `openDb()` — they do not import node:sqlite
// directly, keeping the backend coupling to one file.
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
// Per-project Database singleton
// ============================================================================

export const KERNEL_SCHEMA_VERSION = "3.0.0";
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

const dbRegistry = new Map<string, DatabaseSync>();

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

// Open (or return the cached connection for) the project's state DB.
// Idempotent: a second call with the same `projectDir` returns the
// same Database instance — migrations run on first open only.
//
// `busyTimeoutMs` is honored only on the first open for a given
// projectDir; tests that need a low value to exercise STATE_BUSY
// should pass a fresh tempdir per case.
export function openDb(projectDir: string, opts?: { busyTimeoutMs?: number }): DatabaseSync {
  const resolved = resolve(projectDir);
  const cached = dbRegistry.get(resolved);
  if (cached) return cached;

  const claudeDir = join(resolved, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const dbPath = join(claudeDir, "state.db");

  const db = new DatabaseSync(dbPath);
  // WAL — readers never block writers, writers see a consistent
  // pre-commit snapshot. wal_autocheckpoint at 4000 pages (~16 MB)
  // keeps WAL growth bounded between checkpoints without thrashing.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA wal_autocheckpoint = 4000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${opts?.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);

  runMigrations(db);
  dbRegistry.set(resolved, db);
  return db;
}

// Drop the cached singleton for a project so the next openDb call
// re-enters the migration runner. Closes the underlying Database.
// Primarily a test hook; safe to call when no cached connection
// exists.
export function closeDb(projectDir: string): void {
  const resolved = resolve(projectDir);
  const cached = dbRegistry.get(resolved);
  if (!cached) return;
  cached.close();
  dbRegistry.delete(resolved);
}

// ============================================================================
// Migration runner
// ============================================================================

// Applies every `<seq>-<name>.sql` file under packages/kernel/migrations
// that has not yet been recorded in `kernel_schema_versions`. Each file
// runs in its own short transaction; on failure the row is not
// recorded so the next start retries the same file.
//
// Re-running against a current DB is a no-op — the version table acts
// as the seen-set.
function runMigrations(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS kernel_schema_versions (
    component TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const dir = migrationsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  const seen = new Set<string>();
  for (const row of db.prepare("SELECT component FROM kernel_schema_versions").all()) {
    seen.add(String((row as { component: unknown }).component));
  }

  for (const file of files) {
    const component = file.replace(/\.sql$/, "");
    if (seen.has(component)) continue;

    const sql = readFileSync(join(dir, file), "utf8");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      // Migration apply runs at process start, before any FSM tick
      // has captured a NowToken — the applied_at stamp is documented
      // as an ambient-clock allowance alongside captureNow() and ids.ts.
      const appliedAt = new Date().toISOString(); // allow-ambient-clock: migration apply runs before any FSM tick has captured a NowToken
      db.prepare("INSERT INTO kernel_schema_versions VALUES (?, ?, ?)").run(
        component,
        KERNEL_SCHEMA_VERSION,
        appliedAt,
      );
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* tx may already be terminated */ }
      throw new KernelError({
        code: "SCHEMA_MIGRATION_FAILED",
        message: `migration ${file}: ${(err as Error).message}`,
        detail: { file },
      });
    }
  }
}
