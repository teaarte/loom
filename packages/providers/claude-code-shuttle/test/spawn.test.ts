import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProviderSpawnRequest } from "@loomfsm/kernel";

import { claudeCodeShuttleProvider } from "../src/index.js";

function baseRequest(
  overrides: Partial<ProviderSpawnRequest> = {},
): ProviderSpawnRequest {
  return {
    agent: "reviewer",
    agent_run_id: "agent-run-01HX0000000000000000000000",
    phase: "review",
    model: "host-managed",
    prompt: "review the change",
    ...overrides,
  };
}

describe("claudeCodeShuttleProvider", () => {
  it("declares the conservative shuttle capability matrix", () => {
    const { capabilities, name } = claudeCodeShuttleProvider;
    assert.equal(name, "claude-code-shuttle");
    assert.equal(capabilities.execution, "shuttle");
    assert.equal(capabilities.idempotent_spawn, false);
    assert.equal(capabilities.reports_usage, false);
    assert.deepEqual(capabilities.features, []);
    assert.deepEqual(capabilities.models, []);
    assert.equal(capabilities.honors_mcp_whitelist, true);
  });

  it("returns a shuttle-typed ProviderResult", async () => {
    const result = await claudeCodeShuttleProvider.spawn(baseRequest());
    assert.equal(result.type, "shuttle");
  });

  it("passes request fields through to the intent verbatim", async () => {
    const req = baseRequest({
      system_prompt: "you are a reviewer",
      mcp_tools_available: ["Read", "Grep"],
    });
    const result = await claudeCodeShuttleProvider.spawn(req);
    assert.equal(result.type, "shuttle");
    if (result.type !== "shuttle") return;
    const { intent } = result;
    assert.equal(intent.agent, req.agent);
    assert.equal(intent.agent_run_id, req.agent_run_id);
    assert.equal(intent.phase, req.phase);
    assert.equal(intent.model, req.model);
    assert.equal(intent.prompt, req.prompt);
    assert.equal(intent.system_prompt, req.system_prompt);
    assert.deepEqual(intent.mcp_tools_available, req.mcp_tools_available);
  });

  it("omits optional fields from the intent when the request omits them", async () => {
    const result = await claudeCodeShuttleProvider.spawn(baseRequest());
    assert.equal(result.type, "shuttle");
    if (result.type !== "shuttle") return;
    const { intent } = result;
    assert.ok(
      !Object.prototype.hasOwnProperty.call(intent, "system_prompt"),
      "system_prompt should be absent from intent when absent from request",
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(intent, "mcp_tools_available"),
      "mcp_tools_available should be absent from intent when absent from request",
    );
  });

  it("stamps extras.runner_hint with the host runner identifier", async () => {
    const result = await claudeCodeShuttleProvider.spawn(baseRequest());
    assert.equal(result.type, "shuttle");
    if (result.type !== "shuttle") return;
    assert.equal(result.intent.extras?.runner_hint, "claude-code-task");
  });

  it("provider runner_hint wins over an inbound override; other extras pass through", async () => {
    const req = baseRequest({
      extras: { runner_hint: "evil-runner", other: 42, nested: { a: 1 } },
    });
    const result = await claudeCodeShuttleProvider.spawn(req);
    assert.equal(result.type, "shuttle");
    if (result.type !== "shuttle") return;
    const extras = result.intent.extras;
    assert.ok(extras, "intent must carry extras");
    assert.equal(extras.runner_hint, "claude-code-task");
    assert.equal(extras.other, 42);
    assert.deepEqual(extras.nested, { a: 1 });
  });

  it("does not mutate the input request and isolates extras across calls", async () => {
    const inboundExtras = { runner_hint: "evil-runner", other: 42 };
    const req = baseRequest({ extras: inboundExtras });

    const first = await claudeCodeShuttleProvider.spawn(req);
    const second = await claudeCodeShuttleProvider.spawn(req);

    // Caller's extras object survives untouched — the provider must not
    // stamp runner_hint onto the inbound reference, or hostile / repeat
    // callers would see their state corrupted across spawn boundaries.
    assert.equal(
      inboundExtras.runner_hint,
      "evil-runner",
      "spawn() must not mutate the caller's extras.runner_hint",
    );
    assert.equal(req.extras, inboundExtras, "spawn() must not replace req.extras");

    assert.equal(first.type, "shuttle");
    assert.equal(second.type, "shuttle");
    if (first.type !== "shuttle" || second.type !== "shuttle") return;

    // Two spawns from the same request must produce independent extras
    // objects — a shared reference would let a later mutation on one
    // intent leak into the other.
    assert.notEqual(
      first.intent.extras,
      second.intent.extras,
      "each spawn must allocate a fresh extras object",
    );
    assert.notEqual(
      first.intent.extras,
      inboundExtras,
      "intent.extras must not alias the caller's extras object",
    );
  });
});
