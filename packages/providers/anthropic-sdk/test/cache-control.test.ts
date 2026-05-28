import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProviderSpawnRequest } from "@loom/kernel";

import { splitForCache } from "../src/cache-control.js";

function baseRequest(
  overrides: Partial<ProviderSpawnRequest> = {},
): ProviderSpawnRequest {
  return {
    agent: "writer",
    agent_run_id: "agent-run-01HX0000000000000000000000",
    phase: "implementation",
    model: "claude-opus-4-5",
    system_prompt: "you are a helpful assistant",
    prompt: "draft a poem",
    ...overrides,
  };
}

describe("splitForCache", () => {
  it("with system_prompt — emits a single system block with cache_control", () => {
    const payload = splitForCache(
      baseRequest({ system_prompt: "you are X" }),
    );
    assert.deepEqual(payload.system, [
      { type: "text", text: "you are X", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("without system_prompt — omits the system field entirely", () => {
    const undefinedPayload = splitForCache(
      baseRequest({ system_prompt: undefined }),
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(undefinedPayload, "system"),
      false,
      "system field must be absent when system_prompt is undefined",
    );

    const emptyPayload = splitForCache(baseRequest({ system_prompt: "" }));
    assert.equal(
      Object.prototype.hasOwnProperty.call(emptyPayload, "system"),
      false,
      "system field must be absent when system_prompt is the empty string",
    );
  });

  it("user message echoes the prompt verbatim", () => {
    const cases = [
      "short",
      "multi\nline\nprompt with embedded newlines",
      'special chars: "quotes", <tags>, {curly}, \\backslashes, emoji 🛰️',
    ];
    for (const prompt of cases) {
      const payload = splitForCache(baseRequest({ prompt }));
      assert.equal(payload.messages.length, 1);
      const first = payload.messages[0];
      assert.ok(first);
      assert.equal(first.role, "user");
      assert.equal(first.content.length, 1);
      const block = first.content[0];
      assert.ok(block);
      assert.equal(block.type, "text");
      assert.equal(block.text, prompt);
    }
  });

  it("does not mutate the input and produces independent payloads on repeated calls", () => {
    const req = baseRequest({
      system_prompt: "stable prefix",
      prompt: "dynamic suffix",
    });
    const beforeSystem = req.system_prompt;
    const beforePrompt = req.prompt;

    const first = splitForCache(req);
    const second = splitForCache(req);

    assert.equal(req.system_prompt, beforeSystem);
    assert.equal(req.prompt, beforePrompt);
    assert.notEqual(first.messages, second.messages);
    assert.notEqual(first.system, second.system);
  });

  it("cache_control marker correlates with presence of system_prompt", () => {
    // When system_prompt is present: exactly one block, and that block
    // carries cache_control. When absent: no system field at all (and
    // therefore no marker). Stronger than a bare "≤ 1" counter — guards
    // against both prefix fragmentation AND silent loss of the marker.
    const withPrefix = splitForCache(
      baseRequest({ system_prompt: "stable prefix" }),
    );
    assert.equal(withPrefix.system?.length, 1);
    assert.deepEqual(withPrefix.system?.[0]?.cache_control, {
      type: "ephemeral",
    });

    const withoutPrefix = splitForCache(
      baseRequest({ system_prompt: undefined }),
    );
    assert.equal(withoutPrefix.system, undefined);
  });
});
