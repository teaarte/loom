import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { reconcileExtensions, type DiscoveredManifest } from "../src/extension-loader.js";
import { makeAgentRunId, makeRecoveryId } from "../src/ids.js";
import { initializeTask } from "../src/lib/initialize-task.js";
import { recoverTask } from "../src/lib/recover-task.js";
import { KernelError, closeDb, loadState, openDb, withStateTransaction } from "../src/state.js";
import type { NowToken } from "../src/types/now.js";
import type { Transaction } from "../src/types/transaction.js";

const NOW = "2026-05-29T12:00:00.000Z" as NowToken;
const LATER = "2026-05-29T13:00:00.000Z" as NowToken;

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

// Seed a task with the given phases; returns the driver_state_id.
async function seedTask(dir: string, phases: string[]): Promise<string> {
  return withStateTransaction(dir, NOW, async (tx) => {
    const ids = await initializeTask(tx, {
      project_dir: dir,
      task: "recover me",
      client_idempotency_uuid: `uuid-${phases.join("-")}`,
      phases,
    });
    return ids.driver_state_id;
  });
}

// Insert a pending_agents row + matching phase so a recovery has
// something to drain. The phase must exist (FK on agent_records is the
// strict edge; pending_agents has no FK but we keep phases consistent).
async function addPending(tx: Transaction, agentRunId: string, phase: string): Promise<void> {
  await tx.exec(
    "INSERT INTO pending_agents (agent_run_id, agent, phase, model, started_at) " +
      "VALUES (?, 'impl', ?, NULL, ?)",
    [agentRunId, phase, NOW],
  );
}

async function freshProject(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "loom-recover-"));
  openDb(dir);
  await reconcileExtensions({ manifests: [bundleManifest("code-fixture")], project_dir: dir, now: NOW });
  return dir;
}

async function read<T>(dir: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return withStateTransaction(dir, LATER, fn);
}

function cleanup(dir: string): void {
  try {
    closeDb(dir);
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
}

describe("recoverTask", () => {
  let dir: string;
  afterEach(() => cleanup(dir));

  it("abandon drains pending, sets status='abandoned' verdict=null, writes a ledger row", async () => {
    dir = await freshProject();
    const dsid = await seedTask(dir, ["work"]);
    const recoveryId = makeRecoveryId();
    await withStateTransaction(dir, LATER, async (tx) => {
      await addPending(tx, makeAgentRunId(), "work");
      const res = await recoverTask(tx, { driver_state_id: dsid, choice: "abandon", recovery_id: recoveryId });
      assert.equal(res.reenter, false);
      assert.equal(res.recovery_id, recoveryId);
    });

    const state = await read(dir, loadState);
    assert.equal(state.status, "abandoned");
    assert.equal(state.verdict, null);
    assert.equal(state.pipeline_violation, null);
    assert.equal(state.pending_agents.length, 0);
    assert.equal(state.ended_at, LATER);

    const ledger = await read(dir, (tx) =>
      tx.queryRow("SELECT key FROM kernel_idempotency_ledger WHERE key = ?", [
        `recovery:${dsid}:abandon:${recoveryId}`,
      ]),
    );
    assert.notEqual(ledger, null);
  });

  it("abandon on an already-abandoned task is an idempotent no-op", async () => {
    dir = await freshProject();
    const dsid = await seedTask(dir, ["work"]);
    await withStateTransaction(dir, LATER, (tx) =>
      recoverTask(tx, { driver_state_id: dsid, choice: "abandon", recovery_id: makeRecoveryId() }),
    );
    const afterFirst = await read(dir, loadState);

    // A second abandon with a FRESH recovery_id must not rewrite ended_at.
    await withStateTransaction(dir, "2026-05-29T14:00:00.000Z" as NowToken, (tx) =>
      recoverTask(tx, { driver_state_id: dsid, choice: "abandon", recovery_id: makeRecoveryId() }),
    );
    const afterSecond = await read(dir, loadState);

    assert.equal(afterSecond.status, "abandoned");
    assert.equal(afterSecond.ended_at, afterFirst.ended_at);
  });

  it("force-close completes the task, closes phases, sets the violation (INV_007 holds)", async () => {
    dir = await freshProject();
    const dsid = await seedTask(dir, ["context", "work"]);
    const recoveryId = makeRecoveryId();
    // commit succeeding is itself the INV_007 assertion (the invariant
    // runs on commit; an open phase under a non-null verdict would throw).
    await withStateTransaction(dir, LATER, async (tx) => {
      await addPending(tx, makeAgentRunId(), "work");
      const res = await recoverTask(tx, { driver_state_id: dsid, choice: "force-close", recovery_id: recoveryId });
      assert.equal(res.reenter, false);
    });

    const state = await read(dir, loadState);
    assert.equal(state.status, "completed");
    assert.equal(state.verdict, "failed_force_closed");
    assert.equal(state.pipeline_violation, "force-close");
    assert.equal(state.pending_agents.length, 0);
    for (const phase of state.phases) {
      assert.equal(phase.status, "skipped");
      assert.equal(phase.skipped_reason, "force-closed");
    }
  });

  it("retry on clean state is reenter=true with no mutation", async () => {
    dir = await freshProject();
    const dsid = await seedTask(dir, ["work"]);
    const before = await read(dir, loadState);
    const res = await withStateTransaction(dir, LATER, (tx) =>
      recoverTask(tx, { driver_state_id: dsid, choice: "retry", recovery_id: makeRecoveryId() }),
    );
    assert.equal(res.reenter, true);
    const after = await read(dir, loadState);
    assert.equal(after.status, before.status);
    assert.equal(after.driver.step_index, before.driver.step_index);
  });

  it("retry with a pending row is RECOVERY_INVALID with no state change", async () => {
    dir = await freshProject();
    const dsid = await seedTask(dir, ["work"]);
    // Recover at NOW (matching the pending row's started_at) — a
    // non-draining recovery that leaves a stale-timestamped pending row
    // would otherwise trip the zombie-pending invariant on commit.
    await withStateTransaction(dir, NOW, (tx) => addPending(tx, makeAgentRunId(), "work"));

    await assert.rejects(
      () =>
        withStateTransaction(dir, NOW, (tx) =>
          recoverTask(tx, { driver_state_id: dsid, choice: "retry", recovery_id: makeRecoveryId() }),
        ),
      (err) => err instanceof KernelError && err.code === "RECOVERY_INVALID",
    );
    const after = await withStateTransaction(dir, NOW, loadState);
    assert.equal(after.pending_agents.length, 1);
  });

  it("retry-failed accepts named pending ids and leaves the rows intact", async () => {
    dir = await freshProject();
    const dsid = await seedTask(dir, ["work"]);
    const failed = makeAgentRunId();
    const good = makeAgentRunId();
    await withStateTransaction(dir, NOW, async (tx) => {
      await addPending(tx, failed, "work");
      await addPending(tx, good, "work");
    });

    // retry-failed retains the still-pending rows, so the recovery and the
    // read run at NOW (the rows' started_at) to stay clear of the zombie
    // window.
    const res = await withStateTransaction(dir, NOW, (tx) =>
      recoverTask(tx, { driver_state_id: dsid, choice: "retry-failed", agent_run_ids: [failed], recovery_id: makeRecoveryId() }),
    );
    assert.equal(res.reenter, true);
    const after = await withStateTransaction(dir, NOW, loadState);
    // Both rows still pending — the good sibling intact, the named row
    // re-shuttled on FSM re-entry.
    assert.equal(after.pending_agents.length, 2);
  });

  it("retry-failed with empty ids is RECOVERY_INVALID", async () => {
    dir = await freshProject();
    const dsid = await seedTask(dir, ["work"]);
    await assert.rejects(
      () =>
        withStateTransaction(dir, LATER, (tx) =>
          recoverTask(tx, { driver_state_id: dsid, choice: "retry-failed", agent_run_ids: [], recovery_id: makeRecoveryId() }),
        ),
      (err) => err instanceof KernelError && err.code === "RECOVERY_INVALID",
    );
  });

  it("retry-failed with unknown ids is RECOVERY_STALE listing them", async () => {
    dir = await freshProject();
    const dsid = await seedTask(dir, ["work"]);
    const ghost = makeAgentRunId();
    await assert.rejects(
      () =>
        withStateTransaction(dir, LATER, (tx) =>
          recoverTask(tx, { driver_state_id: dsid, choice: "retry-failed", agent_run_ids: [ghost], recovery_id: makeRecoveryId() }),
        ),
      (err) =>
        err instanceof KernelError &&
        err.code === "RECOVERY_STALE" &&
        Array.isArray(err.detail?.["unknown_agent_run_ids"]) &&
        (err.detail["unknown_agent_run_ids"] as string[]).includes(ghost),
    );
  });

  it("cancel-pending drains pending, advances the step, sets the violation", async () => {
    dir = await freshProject();
    const dsid = await seedTask(dir, ["work"]);
    const before = await read(dir, loadState);
    await withStateTransaction(dir, LATER, async (tx) => {
      await addPending(tx, makeAgentRunId(), "work");
      const res = await recoverTask(tx, { driver_state_id: dsid, choice: "cancel-pending", recovery_id: makeRecoveryId() });
      assert.equal(res.reenter, true);
    });
    const after = await read(dir, loadState);
    assert.equal(after.pending_agents.length, 0);
    assert.equal(after.driver.step_index, before.driver.step_index + 1);
    assert.equal(after.pipeline_violation, "pending-cancel");
  });

  it("abandon of an in-progress task tags outcome=applied", async () => {
    dir = await freshProject();
    const dsid = await seedTask(dir, ["work"]);
    const res = await withStateTransaction(dir, LATER, async (tx) => {
      await addPending(tx, makeAgentRunId(), "work");
      return recoverTask(tx, { driver_state_id: dsid, choice: "abandon", recovery_id: makeRecoveryId() });
    });
    assert.equal(res.outcome, "applied");
  });

  it("abandon of an already-terminal task tags outcome=idempotent", async () => {
    dir = await freshProject();
    const dsid = await seedTask(dir, ["work"]);
    await withStateTransaction(dir, LATER, (tx) =>
      recoverTask(tx, { driver_state_id: dsid, choice: "abandon", recovery_id: makeRecoveryId() }),
    );
    // A second abandon (fresh recovery_id) finds a terminal task → no state
    // change → idempotent.
    const res = await withStateTransaction(dir, "2026-05-29T14:00:00.000Z" as NowToken, (tx) =>
      recoverTask(tx, { driver_state_id: dsid, choice: "abandon", recovery_id: makeRecoveryId() }),
    );
    assert.equal(res.outcome, "idempotent");
  });

  it("cancel-pending with nothing outstanding tags outcome=raced", async () => {
    dir = await freshProject();
    const dsid = await seedTask(dir, ["work"]);
    // No pending agents and no pending user answer — a racing delivery
    // already drained the work, so this cancel-pending is a serialized
    // no-op (raced), though the violation + step advance still record.
    const res = await withStateTransaction(dir, LATER, (tx) =>
      recoverTask(tx, { driver_state_id: dsid, choice: "cancel-pending", recovery_id: makeRecoveryId() }),
    );
    assert.equal(res.outcome, "raced");
    const after = await read(dir, loadState);
    assert.equal(after.pipeline_violation, "pending-cancel");
  });

  it("retry against a terminal (force-closed) task is RECOVERY_TERMINAL", async () => {
    dir = await freshProject();
    const dsid = await seedTask(dir, ["work"]);
    await withStateTransaction(dir, LATER, (tx) =>
      recoverTask(tx, { driver_state_id: dsid, choice: "force-close", recovery_id: makeRecoveryId() }),
    );
    await assert.rejects(
      () =>
        withStateTransaction(dir, LATER, (tx) =>
          recoverTask(tx, { driver_state_id: dsid, choice: "retry", recovery_id: makeRecoveryId() }),
        ),
      (err) => err instanceof KernelError && err.code === "RECOVERY_TERMINAL",
    );
  });

  it("replaying the same recovery_id re-mutates nothing", async () => {
    dir = await freshProject();
    const dsid = await seedTask(dir, ["work"]);
    const recoveryId = makeRecoveryId();
    await withStateTransaction(dir, LATER, async (tx) => {
      await addPending(tx, makeAgentRunId(), "work");
      await recoverTask(tx, { driver_state_id: dsid, choice: "cancel-pending", recovery_id: recoveryId });
    });
    const afterFirst = await read(dir, loadState);

    // Same recovery_id again — the replay guard short-circuits before any
    // mutation, so the step does not advance a second time.
    const replay = await withStateTransaction(dir, "2026-05-29T15:00:00.000Z" as NowToken, (tx) =>
      recoverTask(tx, { driver_state_id: dsid, choice: "cancel-pending", recovery_id: recoveryId }),
    );
    assert.equal(replay.reenter, true);
    const afterReplay = await read(dir, loadState);
    assert.equal(afterReplay.driver.step_index, afterFirst.driver.step_index);
    assert.equal(afterReplay.pending_agents.length, afterFirst.pending_agents.length);
  });
});
