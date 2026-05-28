import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  reconcileExtensions,
  type DiscoveredManifest,
} from "../src/extension-loader.js";
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

const FIXED_NOW = "2026-05-28T10:00:00.000Z" as NowToken;

function bundleManifest(name: string): DiscoveredManifest {
  return {
    path: `/fixture/bundle/${name}`,
    raw: {
      manifest_version: "1.0",
      name,
      display_name: name,
      description: "fixture bundle",
      version: "1.0.0",
      kind: "bundle",
      publisher: "@loom",
      capabilities: [],
      requires: { kernel_api: "^3.0.0" },
    },
  };
}

async function freshProject(opts?: { seedBundle?: boolean }): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "loom-init-task-"));
  openDb(dir);
  const manifests: DiscoveredManifest[] =
    opts?.seedBundle === false ? [] : [bundleManifest("code-fixture")];
  await reconcileExtensions({ manifests, project_dir: dir, now: FIXED_NOW });
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
