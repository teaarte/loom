import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { DRIVER_STATE_ID_PATTERN, TASK_ID_PATTERN } from "../src/ids.js";
import { initializeTask } from "../src/lib/initialize-task.js";
import {
  KernelError,
  closeDb,
  loadState,
  openDb,
  withStateTransaction,
} from "../src/state.js";
import type { NowToken } from "../src/types/now.js";
import type { Transaction } from "../src/types/transaction.js";

import { installBundleRow } from "./helpers/install-bundle.js";

const FIXED_NOW = "2026-05-28T10:00:00.000Z" as NowToken;

async function freshProject(opts?: { seedBundle?: boolean }): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "loom-init-task-"));
  openDb(dir);
  if (opts?.seedBundle !== false) installBundleRow(dir, "code-fixture", FIXED_NOW);
  return dir;
}

// Read-after-write through a fresh tx (committed-snapshot read).
async function read<T>(dir: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return withStateTransaction(dir, FIXED_NOW, fn);
}

function cleanup(dir: string): void {
  try {
    closeDb(dir);
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
}

describe("initializeTask", () => {
  let dir: string;
  afterEach(() => cleanup(dir));

  it("seeds the full task-create row set + a null-blob ledger row", async () => {
    dir = await freshProject();
    const ids = await withStateTransaction(dir, FIXED_NOW, (tx) =>
      initializeTask(tx, {
        project_dir: dir,
        task: "fix the login bug",
        client_idempotency_uuid: "uuid-create-1",
        phases: ["context", "plan"],
      }),
    );

    assert.match(ids.task_id, TASK_ID_PATTERN);
    assert.match(ids.driver_state_id, DRIVER_STATE_ID_PATTERN);

    const state = await read(dir, (tx) => loadState(tx));
    assert.equal(state.bundle, "code-fixture");
    assert.equal(state.task, "fix the login bug");
    assert.equal(state.status, "in_progress");
    assert.equal(state.started_at, FIXED_NOW);
    assert.equal(state.driver_state_id, ids.driver_state_id);
    assert.equal(state.task_id, ids.task_id);
    assert.equal(state.driver.flow_name, "standard");
    assert.equal(state.driver.step_index, 0);
    assert.equal(state.driver.complete, false);
    assert.equal(state.agents_count, 0);
    assert.equal(state.total_tokens_in, 0);
    assert.equal(state.total_tokens_out, 0);
    assert.equal(state.total_tokens_cached, 0);
    assert.deepEqual(
      state.phases.map((p) => p.name).sort(),
      ["context", "plan"],
    );

    const ledger = await read(dir, (tx) =>
      tx.queryRow<{ response_blob: string | null; task_id: string; driver_state_id: string }>(
        "SELECT response_blob, task_id, driver_state_id FROM kernel_idempotency_ledger WHERE key = ?",
        ["task-create:uuid-create-1"],
      ),
    );
    assert.ok(ledger !== null);
    assert.equal(ledger?.response_blob, null);
    assert.equal(ledger?.task_id, ids.task_id);
    assert.equal(ledger?.driver_state_id, ids.driver_state_id);
  });

  it("seeds decisions from the generic initial_decisions blob; complexity_hint wins over a seeded complexity", async () => {
    dir = await freshProject();
    await withStateTransaction(dir, FIXED_NOW, (tx) =>
      initializeTask(tx, {
        project_dir: dir,
        task: "seed opening decisions",
        client_idempotency_uuid: "uuid-init-decisions",
        complexity_hint: "complex",
        // Arbitrary bundle-named keys ride through verbatim — the kernel
        // names none of them. `complexity` here is overridden by the
        // first-class complexity_hint.
        initial_decisions: { tests_mode: "tdd", foo: 1, complexity: "simple" },
        phases: ["context"],
      }),
    );

    const state = await read(dir, (tx) => loadState(tx));
    assert.equal(state.decisions["tests_mode"], "tdd");
    assert.equal(state.decisions["foo"], 1);
    assert.equal(state.decisions["complexity"], "complex");
  });

  it("leaves decisions empty when neither initial_decisions nor complexity_hint is supplied", async () => {
    dir = await freshProject();
    await withStateTransaction(dir, FIXED_NOW, (tx) =>
      initializeTask(tx, {
        project_dir: dir,
        task: "no opening decisions",
        client_idempotency_uuid: "uuid-no-decisions",
        phases: ["context"],
      }),
    );

    const state = await read(dir, (tx) => loadState(tx));
    assert.deepEqual(state.decisions, {});
  });

  it("replays the persisted identity for a repeat client UUID (no second row)", async () => {
    dir = await freshProject();
    const first = await withStateTransaction(dir, FIXED_NOW, (tx) =>
      initializeTask(tx, {
        project_dir: dir,
        task: "ship the feature",
        client_idempotency_uuid: "uuid-create-2",
        phases: ["context"],
      }),
    );
    const second = await withStateTransaction(dir, FIXED_NOW, (tx) =>
      initializeTask(tx, {
        project_dir: dir,
        task: "ship the feature",
        client_idempotency_uuid: "uuid-create-2",
        phases: ["context"],
      }),
    );

    assert.equal(second.task_id, first.task_id);
    assert.equal(second.driver_state_id, first.driver_state_id);

    // The single-row pipeline_state table proves no second insert ran;
    // the phase set stays at one row.
    const phaseCount = await read(dir, (tx) =>
      tx.queryRow<{ c: number }>("SELECT COUNT(*) AS c FROM phases"),
    );
    assert.equal(Number(phaseCount?.c), 1);
  });

  it("refuses an occupied slot with typed PROJECT_TASK_ACTIVE, not a raw constraint error", async () => {
    dir = await freshProject();
    await withStateTransaction(dir, FIXED_NOW, (tx) =>
      initializeTask(tx, {
        project_dir: dir,
        task: "first task",
        client_idempotency_uuid: "uuid-occupied-1",
        phases: ["context"],
      }),
    );

    // A SECOND create under a DIFFERENT client uuid (a new task, not a
    // replay) finds the single-task slot already taken. The blind INSERT
    // would otherwise trip the row-identity CHECK and surface a raw backend
    // error; the pre-check converts it into a typed, actionable refusal.
    await assert.rejects(
      withStateTransaction(dir, FIXED_NOW, (tx) =>
        initializeTask(tx, {
          project_dir: dir,
          task: "second task",
          client_idempotency_uuid: "uuid-occupied-2",
          phases: ["context"],
        }),
      ),
      (err: unknown) =>
        err instanceof KernelError &&
        err.code === "PROJECT_TASK_ACTIVE" &&
        err.detail?.["status"] === "in_progress",
    );
  });

  it("refuses when no enabled bundle is installed", async () => {
    dir = await freshProject({ seedBundle: false });
    await assert.rejects(
      withStateTransaction(dir, FIXED_NOW, (tx) =>
        initializeTask(tx, {
          project_dir: dir,
          task: "no bundle here",
          client_idempotency_uuid: "uuid-create-3",
          phases: ["context"],
        }),
      ),
      (err: unknown) => err instanceof KernelError && err.code === "NO_ENABLED_BUNDLE",
    );
  });
});
