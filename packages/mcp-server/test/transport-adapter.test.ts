import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  KernelDirective,
  ProviderShuttleIntent,
  UserAnswerSchema,
} from "@loomfsm/kernel";

import { createTransportAdapter, shape } from "../src/transport-adapter.js";

const CTX = { driver_state_id: "d-ctx" };

function intent(over: Partial<ProviderShuttleIntent> = {}): ProviderShuttleIntent {
  return {
    agent: "reviewer",
    agent_run_id: "ar-00000000-0000-0000-0000-000000000001",
    phase: "review",
    model: "fast",
    prompt: "review the diff",
    ...over,
  };
}

const ANSWERS: UserAnswerSchema = {
  options: [
    { verbs: ["yes", "1"], label: "Approve", produces: { decision: "accept" } },
  ],
};

describe("transport-adapter — KernelDirective → TransportResponse", () => {
  it("advance returns the KERNEL_INVARIANT error envelope", () => {
    const res = shape({ kind: "advance" }, CTX);
    assert.equal(res.status, "error");
    if (res.status !== "error") return;
    assert.equal(res.code, "KERNEL_INVARIANT");
    assert.equal(res.driver_state_id, "d-ctx");
    assert.deepEqual(res.recovery_options, []);
  });

  it("shuttle maps to spawn-agent with runner_hint and a derived description", () => {
    const directive: KernelDirective = { kind: "shuttle", spawn: intent() };
    const res = shape(directive, CTX);
    assert.equal(res.status, "spawn-agent");
    if (res.status !== "spawn-agent") return;
    assert.equal(res.driver_state_id, "d-ctx");
    assert.equal(res.agent, "reviewer");
    assert.equal(res.agent_run_id, "ar-00000000-0000-0000-0000-000000000001");
    assert.equal(res.spawn_request.runner_hint, "mcp-server");
    assert.equal(res.spawn_request.description, "reviewer (review)");
    assert.equal(res.spawn_request.prompt, "review the diff");
    assert.equal(res.spawn_request.model, "fast");
  });

  it("shuttle carries extras through to the spawn_request when present", () => {
    const directive: KernelDirective = {
      kind: "shuttle",
      spawn: intent({ extras: { provider: "stub", template_path: "t.md" } }),
    };
    const res = shape(directive, CTX);
    assert.equal(res.status, "spawn-agent");
    if (res.status !== "spawn-agent") return;
    assert.deepEqual(res.spawn_request.extras, { provider: "stub", template_path: "t.md" });
  });

  it("shuttle-batch produces a spawns array of length N, each with runner_hint", () => {
    const directive: KernelDirective = {
      kind: "shuttle-batch",
      spawns: [
        intent({ agent: "a1", agent_run_id: "ar-00000000-0000-0000-0000-00000000000a" }),
        intent({ agent: "a2", agent_run_id: "ar-00000000-0000-0000-0000-00000000000b" }),
        intent({ agent: "a3", agent_run_id: "ar-00000000-0000-0000-0000-00000000000c" }),
      ],
    };
    const res = shape(directive, CTX);
    assert.equal(res.status, "spawn-agents-parallel");
    if (res.status !== "spawn-agents-parallel") return;
    assert.equal(res.spawns.length, 3);
    assert.deepEqual(
      res.spawns.map((s) => s.agent),
      ["a1", "a2", "a3"],
    );
    for (const s of res.spawns) {
      assert.equal(s.spawn_request.runner_hint, "mcp-server");
    }
  });

  it("ask-user is an identity passthrough using the directive's driver_state_id", () => {
    const directive: KernelDirective = {
      kind: "ask-user",
      driver_state_id: "d-gate",
      gate: "gate-plan",
      gate_event_id: "gev-00000000-0000-0000-0000-000000000001",
      message: "Approve the plan?",
      valid_answers: ANSWERS,
    };
    const res = shape(directive, CTX);
    assert.deepEqual(res, {
      status: "ask-user",
      driver_state_id: "d-gate",
      gate: "gate-plan",
      gate_event_id: "gev-00000000-0000-0000-0000-000000000001",
      message: "Approve the plan?",
      valid_answers: ANSWERS,
    });
  });

  it("complete is an identity passthrough", () => {
    const directive: KernelDirective = {
      kind: "complete",
      task_id: "t-2026-05-28-demo",
      verdict: "accepted",
      summary: "done",
    };
    const res = shape(directive, CTX);
    assert.deepEqual(res, {
      status: "complete",
      task_id: "t-2026-05-28-demo",
      verdict: "accepted",
      summary: "done",
    });
  });

  it("error is an identity passthrough", () => {
    const directive: KernelDirective = {
      kind: "error",
      driver_state_id: "d-err",
      code: "FLOW_OVERFLOW",
      message: "step_index past flow end",
      recovery_options: [{ choice: "abandon", label: "Abandon task" }],
    };
    const res = shape(directive, CTX);
    assert.deepEqual(res, {
      status: "error",
      driver_state_id: "d-err",
      code: "FLOW_OVERFLOW",
      message: "step_index past flow end",
      recovery_options: [{ choice: "abandon", label: "Abandon task" }],
    });
  });

  it("is pure — the same directive in produces structurally equal output", () => {
    const directive: KernelDirective = { kind: "shuttle", spawn: intent() };
    const a = shape(directive, CTX);
    const b = shape(directive, CTX);
    assert.deepEqual(a, b);
  });

  it("createTransportAdapter returns a {shape} object that matches the free function", () => {
    const adapter = createTransportAdapter();
    const directive: KernelDirective = { kind: "shuttle", spawn: intent() };
    assert.deepEqual(adapter.shape(directive, CTX), shape(directive, CTX));
  });
});
