// Intra-process concurrency contract for the pooled state layer.
//
// These specs assert the connection-pool guarantees by CONSTRUCTION,
// before any concurrent / daemon transport exists to exercise them:
//   (a) two concurrent same-project writers → exactly one STATE_BUSY,
//       NEVER a raw "transaction within a transaction" (the failure mode
//       a single shared handle would have produced);
//   (b) a read under withReadTransaction pins one committed snapshot
//       across an interleaved committing writer (no torn mix);
//   (c) two concurrent first-opens of a fresh DB both succeed — the
//       migration window is serialized, so the loser no-ops instead of
//       hard-failing SCHEMA_MIGRATION_FAILED;
//   (d) the pool reuses connections and bounds open handles (no fd leak).
//
// Real SQLite throughout (temp dirs, isolation + cleanup per case). The
// cross-connection first-open race in (c) needs genuine parallelism, so
// it runs two worker threads — each gets its own module instance and its
// own SQLite connection to the same file, exactly like two processes.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Worker } from "node:worker_threads";

import {
  captureNow,
  closeAll,
  KernelError,
  openDb,
  withReadTransaction,
  withStateTransaction,
} from "../src/state.js";
import { POOL_MAX_CONNECTIONS, poolStats } from "../src/state/db.js";
import type { NowToken } from "../src/types/now.js";

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "loom-concurrency-"));
}

function cleanup(projectDir: string): void {
  try { closeAll(projectDir); } catch { /* may have already closed */ }
  rmSync(projectDir, { recursive: true, force: true });
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => { setTimeout(res, ms); });
}

// Insert the canonical baseline so loadState (run by the writer's
// invariant pass) has something to materialize.
async function seedBaseline(
  projectDir: string,
  taskShort: string | null = null,
): Promise<NowToken> {
  const now = captureNow();
  await withStateTransaction(projectDir, now, async (tx) => {
    await tx.exec(
      "INSERT INTO pipeline_state (id, schema_version, project_dir, bundle, " +
        "task, task_short, driver_state_id, status, started_at) " +
        "VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["3.0.0", projectDir, "code", "build a thing", taskShort, "d-baseline", "in_progress", now],
    );
    await tx.exec(
      "INSERT INTO driver_state (id, flow_name, step_index, complete) VALUES (1, 'simple', 0, 0)",
    );
    await tx.exec("INSERT INTO pipeline_counters (id) VALUES (1)");
  });
  return now;
}

// --------------------------------------------------------------------------
// (a) concurrent same-project writers → one STATE_BUSY, never tx-within-tx
// --------------------------------------------------------------------------

describe("withStateTransaction — concurrent same-project writers", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("surfaces contention as exactly one STATE_BUSY, never 'transaction within a transaction'", async () => {
    await seedBaseline(projectDir);

    const BUSY_MS = 200;

    // p1 grabs the writer lock and holds it across an await. Because each
    // operation borrows its OWN pooled connection, p2's BEGIN IMMEDIATE
    // lands on a different handle and contends on the SQLite write lock —
    // it can never re-enter p1's transaction.
    let signalLocked!: () => void;
    const locked = new Promise<void>((res) => { signalLocked = res; });

    const p1 = withStateTransaction(
      projectDir,
      captureNow(),
      async (tx) => {
        await tx.exec("UPDATE pipeline_state SET task_short = 'p1' WHERE id = 1");
        signalLocked();
        await delay(40);
        return "p1";
      },
      { busyTimeoutMs: BUSY_MS },
    );

    await locked; // p1 now holds BEGIN IMMEDIATE

    const p2 = withStateTransaction(
      projectDir,
      captureNow(),
      async (tx) => {
        await tx.exec("UPDATE pipeline_state SET task_short = 'p2' WHERE id = 1");
        return "p2";
      },
      { busyTimeoutMs: BUSY_MS },
    );

    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 1, "exactly one writer commits");
    assert.equal(rejected.length, 1, "exactly one writer is refused");

    const err = (rejected[0] as PromiseRejectedResult).reason;
    assert.ok(err instanceof KernelError, `expected KernelError, got ${String(err)}`);
    assert.equal((err as KernelError).code, "STATE_BUSY");
    assert.doesNotMatch((err as KernelError).message, /transaction within a transaction/i);
    assert.doesNotMatch((err as KernelError).message, /cannot start a transaction/i);

    // The winner's write is the one that survived.
    const value = await withReadTransaction(projectDir, async (tx) =>
      (await tx.queryRow<{ task_short: string | null }>(
        "SELECT task_short FROM pipeline_state WHERE id = 1",
      ))?.task_short ?? null,
    );
    assert.equal(value, "p1");
  });
});

// --------------------------------------------------------------------------
// (b) read snapshot consistency across an interleaved committing writer
// --------------------------------------------------------------------------

describe("withReadTransaction — snapshot consistency", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("pins one committed snapshot across an interleaved writer commit", async () => {
    await seedBaseline(projectDir, "v1");

    let signalPinned!: () => void;
    const pinned = new Promise<void>((res) => { signalPinned = res; });
    let releaseRead!: () => void;
    const writerCommitted = new Promise<void>((res) => { releaseRead = res; });

    const readP = withReadTransaction(projectDir, async (tx) => {
      const r1 = await tx.queryRow<{ task_short: string | null }>(
        "SELECT task_short FROM pipeline_state WHERE id = 1",
      );
      signalPinned(); // snapshot pinned at the first read
      await writerCommitted; // let a writer commit while we hold the snapshot
      const r2 = await tx.queryRow<{ task_short: string | null }>(
        "SELECT task_short FROM pipeline_state WHERE id = 1",
      );
      return [r1?.task_short ?? null, r2?.task_short ?? null] as const;
    });

    await pinned;
    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      await tx.exec("UPDATE pipeline_state SET task_short = ? WHERE id = 1", ["v2"]);
    });
    releaseRead();

    const [first, second] = await readP;
    assert.equal(first, "v1");
    assert.equal(second, "v1", "read transaction must not see the interleaved v2 commit");

    // A fresh read transaction sees the committed value.
    const after = await withReadTransaction(projectDir, async (tx) =>
      (await tx.queryRow<{ task_short: string | null }>(
        "SELECT task_short FROM pipeline_state WHERE id = 1",
      ))?.task_short ?? null,
    );
    assert.equal(after, "v2");
  });
});

// --------------------------------------------------------------------------
// (c) two concurrent first-opens of a fresh DB both succeed
// --------------------------------------------------------------------------

// ESM worker: import the compiled state module, rendezvous on a shared
// barrier so BOTH workers reach the first-open at the same instant, then
// trigger it (openDb → pool construction → migration runner). The barrier
// forces the genuine cross-connection migration-window contention the
// serialized runner must survive — without it a fast worker can finish
// before the other starts, and even a racy runner would pass. Result is
// posted back.
const FIRST_OPEN_WORKER = `
import { parentPort, workerData } from "node:worker_threads";
const { dbModuleUrl, projectDir, barrier } = workerData;
const gate = new Int32Array(barrier);
try {
  const mod = await import(dbModuleUrl);
  const arrived = Atomics.add(gate, 0, 1) + 1;
  Atomics.notify(gate, 0);
  while (Atomics.load(gate, 0) < 2) Atomics.wait(gate, 0, arrived, 200);
  mod.openDb(projectDir);
  parentPort.postMessage({ ok: true });
} catch (err) {
  parentPort.postMessage({
    ok: false,
    code: err && err.code ? err.code : null,
    message: String(err && err.message ? err.message : err),
  });
}
`;

interface WorkerResult { ok: boolean; code?: string | null; message?: string }

describe("migration window — concurrent first-open", () => {
  let projectDir: string;
  let workerDir: string;
  let workerFile: string;
  beforeEach(() => {
    projectDir = freshProject();
    workerDir = mkdtempSync(join(tmpdir(), "loom-concurrency-worker-"));
    workerFile = join(workerDir, "first-open.worker.mjs");
    writeFileSync(workerFile, FIRST_OPEN_WORKER);
  });
  afterEach(() => {
    cleanup(projectDir);
    rmSync(workerDir, { recursive: true, force: true });
  });

  function runFirstOpen(dbModuleUrl: string, barrier: SharedArrayBuffer): Promise<WorkerResult> {
    // Inherit the experimental flags the test runner uses (node:sqlite),
    // minus the runner's own --test flags.
    const execArgv = process.execArgv.filter((a) => !a.startsWith("--test"));
    return new Promise<WorkerResult>((resolve) => {
      const w = new Worker(workerFile, {
        workerData: { dbModuleUrl, projectDir, barrier },
        execArgv,
      });
      w.once("message", (m: WorkerResult) => { resolve(m); void w.terminate(); });
      w.once("error", (e) => { resolve({ ok: false, message: String(e) }); void w.terminate(); });
    });
  }

  it("both first-opens succeed — the serialized window stops the cold-start race", async () => {
    // dist/test/<this>.js → dist/src/state.js
    const dbModuleUrl = new URL("../src/state.js", import.meta.url).href;
    // One barrier shared by both workers so they collide on the first-open.
    const barrier = new SharedArrayBuffer(4);

    const [r1, r2] = await Promise.all([
      runFirstOpen(dbModuleUrl, barrier),
      runFirstOpen(dbModuleUrl, barrier),
    ]);

    assert.equal(r1.ok, true, `worker 1: ${r1.code ?? ""} ${r1.message ?? ""}`);
    assert.equal(r2.ok, true, `worker 2: ${r2.code ?? ""} ${r2.message ?? ""}`);
    assert.notEqual(r1.code, "SCHEMA_MIGRATION_FAILED");
    assert.notEqual(r2.code, "SCHEMA_MIGRATION_FAILED");

    // The schema landed exactly once — each migration file recorded a
    // single version row, no duplicates from a double-apply.
    const db = openDb(projectDir);
    const rows = db
      .prepare("SELECT component, COUNT(*) AS c FROM kernel_schema_versions GROUP BY component")
      .all() as { component: string; c: number }[];
    assert.ok(rows.length >= 1, "at least one migration recorded");
    for (const r of rows) assert.equal(Number(r.c), 1, `one row per migration (${r.component})`);
  });
});

// --------------------------------------------------------------------------
// (d) pool reuses connections, bounds open handles, leaks nothing
// --------------------------------------------------------------------------

describe("ConnectionPool — reuse and bounds", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("reuses one connection across sequential transactions", async () => {
    await seedBaseline(projectDir);

    for (let i = 0; i < 30; i++) {
      await withStateTransaction(projectDir, captureNow(), async (tx) => {
        await tx.exec("UPDATE pipeline_state SET task_short = ? WHERE id = 1", [`tick-${i}`]);
      });
    }

    const stats = poolStats(projectDir);
    assert.ok(stats !== null);
    // 30 sequential borrows reuse the single warm connection — a leak
    // would have opened a fresh handle per call.
    assert.equal(stats.open, 1, "sequential transactions reuse one connection");
    assert.equal(stats.borrowed, 0, "no connection left checked out");
  });

  it("bounds open connections at the cap under concurrency, then reuses", async () => {
    await seedBaseline(projectDir);

    // Fire more concurrent reads than the cap; excess borrowers wait for a
    // release rather than opening unbounded handles.
    const reads = Array.from({ length: POOL_MAX_CONNECTIONS + 4 }, () =>
      withReadTransaction(projectDir, async (tx) => {
        await tx.queryRow<{ c: number }>("SELECT COUNT(*) AS c FROM audit");
        return true;
      }),
    );
    const done = await Promise.all(reads);
    assert.equal(done.length, POOL_MAX_CONNECTIONS + 4);

    const peak = poolStats(projectDir);
    assert.ok(peak !== null);
    assert.ok(peak.open <= POOL_MAX_CONNECTIONS, `open (${peak.open}) must stay at/under the cap`);
    assert.equal(peak.borrowed, 0, "every borrowed connection was returned");

    // A follow-up sequential read reuses a warm connection — the pool
    // does not grow past what concurrency already opened.
    const before = peak.open;
    await withReadTransaction(projectDir, async (tx) => {
      await tx.queryRow<{ c: number }>("SELECT COUNT(*) AS c FROM audit");
    });
    const afterRead = poolStats(projectDir);
    assert.ok(afterRead !== null);
    assert.equal(afterRead.open, before, "sequential read reuses, does not grow the pool");

    // Teardown closes every handle and forgets the pool.
    closeAll(projectDir);
    assert.equal(poolStats(projectDir), null, "closeAll drops the pool — no lingering handles");
  });

  it("resets a read connection on release so a later write reusing it succeeds", async () => {
    await seedBaseline(projectDir);

    // A read tx flips PRAGMA query_only=ON on its borrowed connection.
    // After release the SAME warm connection is the one the next write
    // borrows (single-threaded, free-list of one). If release did not
    // restore query_only=OFF, the reused write would fail with
    // "attempt to write a readonly database".
    await withReadTransaction(projectDir, async (tx) => {
      await tx.queryRow<{ task_short: string | null }>(
        "SELECT task_short FROM pipeline_state WHERE id = 1",
      );
    });
    const reuseStats = poolStats(projectDir);
    assert.equal(reuseStats?.open, 1, "the read reused the one warm connection");

    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      await tx.exec("UPDATE pipeline_state SET task_short = ? WHERE id = 1", ["after-read"]);
    });

    const value = await withReadTransaction(projectDir, async (tx) =>
      (await tx.queryRow<{ task_short: string | null }>(
        "SELECT task_short FROM pipeline_state WHERE id = 1",
      ))?.task_short ?? null,
    );
    assert.equal(value, "after-read", "write on the reused read-connection committed");
  });
});
