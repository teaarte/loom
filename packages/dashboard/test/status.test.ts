// The status→badge collapse: domain-blind (reads only generic FSM fields), so it
// is a pure function and tested without a DOM. Mirrors the signals `loom status`
// surfaces.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { flowMeta, statusBadge } from "../src/lib/status.js";
import type { ProjectStatus } from "../src/lib/types.js";

function status(over: Partial<ProjectStatus>): ProjectStatus {
  return {
    project_dir: "/p",
    has_task: true,
    task_id: "t1",
    task_label: null,
    status: "in_progress",
    verdict: null,
    flow: null,
    active_phase: null,
    parked_gate: null,
    pending_agents: [],
    stalled: false,
    ...over,
  };
}

describe("statusBadge", () => {
  it("is idle with no task", () => {
    assert.deepEqual(statusBadge(null), { tone: "idle", label: "idle" });
    assert.deepEqual(statusBadge(status({ has_task: false })), { tone: "idle", label: "idle" });
  });

  it("warns when parked on a gate (carrying the generic gate name as data)", () => {
    const b = statusBadge(status({ parked_gate: { gate: "plan", message: "m", gate_event_id: "g1" } }));
    assert.equal(b.tone, "warn");
    assert.match(b.label, /parked: plan/);
  });

  it("flags a stalled task", () => {
    assert.deepEqual(statusBadge(status({ stalled: true })), { tone: "bad", label: "stalled" });
  });

  it("shows running + pending count", () => {
    assert.deepEqual(
      statusBadge(status({ status: "in_progress", pending_agents: [{ agent: "a", phase: "p", age_ms: 1 }] })),
      { tone: "ok", label: "running · 1 pending" },
    );
    assert.deepEqual(statusBadge(status({ status: "in_progress" })), { tone: "ok", label: "running" });
  });

  it("reflects the completed verdict", () => {
    assert.deepEqual(statusBadge(status({ status: "completed", verdict: "accepted" })), {
      tone: "ok",
      label: "accepted",
    });
    assert.deepEqual(statusBadge(status({ status: "completed", verdict: "rejected" })), {
      tone: "warn",
      label: "rejected",
    });
  });

  it("marks an abandoned task bad", () => {
    assert.deepEqual(statusBadge(status({ status: "abandoned" })), { tone: "bad", label: "abandoned" });
  });
});

describe("flowMeta", () => {
  it("is null with no status or no flow", () => {
    assert.equal(flowMeta(null), null);
    assert.equal(flowMeta(status({ flow: null })), null);
  });

  it("renders the flow name + step, carrying both as generic data", () => {
    assert.equal(flowMeta(status({ flow: { name: "simple", step_index: 12 }, active_phase: null })), "simple @ step 12");
  });

  it("appends the active phase when present", () => {
    assert.equal(
      flowMeta(status({ flow: { name: "complex", step_index: 3 }, active_phase: "review" })),
      "complex @ step 3 · review",
    );
  });
});
