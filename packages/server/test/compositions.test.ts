// The intake/answer/read-model compositions over a REAL store — the pieces
// the HTTP routes delegate to, exercised without the network or a watcher so
// the assertions are deterministic. No mocked DB; reverting the behaviour
// reddens.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createAndStart, readState } from "@loomfsm/driver";

import { answerGate, readProjectStatus, ServerError, submitTask } from "../src/index.js";
import { cleanup, freshProject, gateRegistry, spawnRegistry } from "./fixtures.js";

const NOW = Date.parse("2026-06-02T10:00:00.000Z");

describe("submitTask — the create-task path", () => {
  it("creates a task and reports its first directive", async () => {
    const dir = await freshProject();
    try {
      const r = await submitTask(dir, spawnRegistry(), { task: "do the work" });
      assert.equal(r.replayed, false);
      assert.ok(r.task_id !== null);
      assert.equal(r.status, "spawn-agent");
      assert.equal((await readState(dir)).status, "in_progress");
    } finally {
      cleanup(dir);
    }
  });

  it("is idempotent — the same task text replays, never double-creates", async () => {
    const dir = await freshProject();
    try {
      const a = await submitTask(dir, spawnRegistry(), { task: "same task" });
      const b = await submitTask(dir, spawnRegistry(), { task: "same task" });
      assert.equal(b.replayed, true);
      assert.equal(a.task_id, b.task_id);
    } finally {
      cleanup(dir);
    }
  });

  it("refuses an empty task with a typed 400", async () => {
    const dir = await freshProject();
    try {
      await assert.rejects(submitTask(dir, spawnRegistry(), { task: "   " }), (err: unknown) => {
        assert.ok(err instanceof ServerError);
        assert.equal(err.code, "TASK_REQUIRED");
        assert.equal(err.httpStatus, 400);
        return true;
      });
    } finally {
      cleanup(dir);
    }
  });

  it("refuses a second, different task while one is live (single-task invariant)", async () => {
    const dir = await freshProject();
    try {
      await submitTask(dir, spawnRegistry(), { task: "first task" });
      await assert.rejects(submitTask(dir, spawnRegistry(), { task: "second task" }), (err: unknown) => {
        assert.ok(err instanceof ServerError);
        assert.equal(err.httpStatus, 409);
        return true;
      });
    } finally {
      cleanup(dir);
    }
  });
});

describe("answerGate — deliver a human answer", () => {
  it("delivers the answer and advances past the gate", async () => {
    const dir = await freshProject();
    try {
      const registry = gateRegistry();
      const created = await submitTask(dir, registry, { task: "gated work" });
      assert.equal(created.status, "ask-user");

      const state = await readState(dir);
      assert.ok(state.driver.pending_user_answer !== null);
      const gateEventId = state.driver.pending_user_answer.gate_event_id;

      const r = await answerGate(dir, registry, { gate_event_id: gateEventId, decision: "accept" });
      assert.equal(r.status, "complete");
      assert.equal((await readState(dir)).status, "completed");
    } finally {
      cleanup(dir);
    }
  });

  it("refuses an answer when no gate is parked", async () => {
    const dir = await freshProject();
    try {
      await submitTask(dir, spawnRegistry(), { task: "ungated" }); // parks on a spawn, not a gate
      await assert.rejects(
        answerGate(dir, spawnRegistry(), { gate_event_id: "ge-x", decision: "accept" }),
        (err: unknown) => {
          assert.ok(err instanceof ServerError);
          assert.equal(err.code, "NO_PARKED_GATE");
          return true;
        },
      );
    } finally {
      cleanup(dir);
    }
  });

  it("refuses an answer when there is no active task", async () => {
    const dir = await freshProject();
    try {
      await assert.rejects(
        answerGate(dir, spawnRegistry(), { gate_event_id: "ge-x", decision: "accept" }),
        (err: unknown) => {
          assert.ok(err instanceof ServerError);
          assert.equal(err.code, "NO_ACTIVE_TASK");
          assert.equal(err.httpStatus, 404);
          return true;
        },
      );
    } finally {
      cleanup(dir);
    }
  });
});

describe("readProjectStatus — the read-model", () => {
  it("matches the canonical state loom status reads", async () => {
    const dir = await freshProject();
    try {
      const registry = spawnRegistry();
      await createAndStart(dir, { registry, task: "snapshot me", client_idempotency_uuid: "cidem-x" });
      const state = await readState(dir);
      const view = await readProjectStatus(dir, NOW);

      assert.equal(view.has_task, true);
      assert.equal(view.task_id, state.task_id);
      assert.equal(view.status, state.status);
      assert.equal(view.flow?.name, state.driver.flow_name);
      assert.equal(view.flow?.step_index, state.driver.step_index);
      assert.equal(view.pending_agents.length, state.pending_agents.length);
    } finally {
      cleanup(dir);
    }
  });

  it("reports a store-less project as idle (has_task: false), never throws", async () => {
    const dir = await freshProject();
    try {
      // freshProject reconciles the bundle but starts no task.
      const view = await readProjectStatus(dir, NOW);
      assert.equal(view.has_task, false);
      assert.equal(view.status, null);
    } finally {
      cleanup(dir);
    }
  });

  it("degrades a momentarily-unreadable store to idle instead of throwing", async () => {
    // A store that exists but cannot be read — a corrupt file, or (the case
    // that bit a real run) a never-checkpointed WAL seen under the control
    // plane's concurrent connections — must not 500 the read endpoint. The
    // read-model reports the project as idle; the next poll recovers once the
    // store settles.
    const dir = mkdtempSync(join(tmpdir(), "loom-server-corrupt-"));
    try {
      mkdirSync(join(dir, ".claude"));
      writeFileSync(join(dir, ".claude", "state.db"), "not a sqlite database\n");
      const view = await readProjectStatus(dir, NOW);
      assert.equal(view.has_task, false);
      assert.equal(view.status, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces a parked gate in the read-model", async () => {
    const dir = await freshProject();
    try {
      const registry = gateRegistry();
      await submitTask(dir, registry, { task: "gated" });
      const view = await readProjectStatus(dir, NOW);
      assert.ok(view.parked_gate !== null);
      assert.equal(view.parked_gate?.gate, "gate-1");
    } finally {
      cleanup(dir);
    }
  });
});
