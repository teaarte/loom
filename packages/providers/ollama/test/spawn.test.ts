import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProviderSpawnRequest } from "@loomfsm/kernel";

import {
  createOllamaProvider,
  ollamaProvider,
  type OllamaChatArgs,
  type OllamaChatResponse,
  type OllamaClientLike,
} from "../src/index.js";

function baseRequest(
  overrides: Partial<ProviderSpawnRequest> = {},
): ProviderSpawnRequest {
  return {
    agent: "reviewer",
    agent_run_id: "agent-run-01HX0000000000000000000000",
    phase: "implementation",
    model: "llama3.1:8b",
    system_prompt: "you are a helpful assistant",
    prompt: "say hello",
    ...overrides,
  };
}

interface FakeClient {
  client: OllamaClientLike;
  calls: OllamaChatArgs[];
}

function makeFakeClient(response: OllamaChatResponse): FakeClient {
  const calls: OllamaChatArgs[] = [];
  const client: OllamaClientLike = {
    chat(args) {
      calls.push(args);
      return Promise.resolve(response);
    },
  };
  return { client, calls };
}

const defaultResponse: OllamaChatResponse = {
  message: { role: "assistant", content: "hello" },
  prompt_eval_count: 10,
  eval_count: 5,
  done: true,
};

describe("createOllamaProvider", () => {
  it("declares the documented capability matrix", () => {
    const { client } = makeFakeClient(defaultResponse);
    const provider = createOllamaProvider({ client });
    assert.equal(provider.name, "ollama");
    assert.equal(provider.capabilities.execution, "async");
    assert.equal(provider.capabilities.idempotent_spawn, false);
    assert.equal(provider.capabilities.reports_usage, true);
    assert.deepEqual(provider.capabilities.features, []);
    assert.deepEqual(provider.capabilities.models, []);
    assert.equal(provider.capabilities.honors_mcp_whitelist, true);
    assert.deepEqual(provider.agent_tools, []);
  });

  it("forwards model and the default num_predict to the client", async () => {
    const fake = makeFakeClient(defaultResponse);
    const provider = createOllamaProvider({ client: fake.client });
    const req = baseRequest();
    await provider.spawn(req);
    assert.equal(fake.calls.length, 1);
    const args = fake.calls[0];
    assert.ok(args);
    assert.equal(args.model, req.model);
    assert.equal(args.options?.num_predict, 4096);
  });

  it("honors req.extras.max_tokens by threading it into options.num_predict", async () => {
    const fake = makeFakeClient(defaultResponse);
    const provider = createOllamaProvider({ client: fake.client });
    await provider.spawn(baseRequest({ extras: { max_tokens: 2048 } }));
    assert.equal(fake.calls[0]?.options?.num_predict, 2048);

    const degenerate: Record<string, unknown>[] = [
      { max_tokens: 0 },
      { max_tokens: -1 },
      { max_tokens: Number.NaN },
      { max_tokens: Number.POSITIVE_INFINITY },
      { max_tokens: "8192" },
    ];
    for (const extras of degenerate) {
      await provider.spawn(baseRequest({ extras }));
    }
    assert.equal(fake.calls.length, 1 + degenerate.length);
    for (let i = 1; i < fake.calls.length; i += 1) {
      const args = fake.calls[i];
      assert.ok(args);
      assert.equal(
        args.options?.num_predict,
        4096,
        `expected 4096 fallback at call ${i}; got ${args.options?.num_predict}`,
      );
    }
  });

  it("includes the system message when system_prompt is present", async () => {
    const fake = makeFakeClient(defaultResponse);
    const provider = createOllamaProvider({ client: fake.client });
    const req = baseRequest({ system_prompt: "you are X", prompt: "do Y" });
    await provider.spawn(req);
    const args = fake.calls[0];
    assert.ok(args);
    assert.deepEqual(args.messages, [
      { role: "system", content: "you are X" },
      { role: "user", content: "do Y" },
    ]);
  });

  it("omits the system message when system_prompt is absent or empty", async () => {
    const fake = makeFakeClient(defaultResponse);
    const provider = createOllamaProvider({ client: fake.client });
    await provider.spawn(baseRequest({ system_prompt: undefined, prompt: "p1" }));
    await provider.spawn(baseRequest({ system_prompt: "", prompt: "p2" }));
    assert.equal(fake.calls.length, 2);
    assert.deepEqual(fake.calls[0]?.messages, [
      { role: "user", content: "p1" },
    ]);
    assert.deepEqual(fake.calls[1]?.messages, [
      { role: "user", content: "p2" },
    ]);
  });

  it("extracts output and maps prompt_eval_count -> tokens.in, eval_count -> tokens.out", async () => {
    const fake = makeFakeClient({
      message: { role: "assistant", content: "hello" },
      prompt_eval_count: 10,
      eval_count: 5,
      done: true,
    });
    const provider = createOllamaProvider({ client: fake.client });
    const result = await provider.spawn(baseRequest());
    assert.equal(result.type, "result");
    if (result.type !== "result") return;
    assert.equal(result.output, "hello");
    assert.deepEqual(result.tokens, { in: 10, out: 5 });
  });

  it("never populates tokens.cached — Ollama has no cache layer", async () => {
    const fake = makeFakeClient(defaultResponse);
    const provider = createOllamaProvider({ client: fake.client });
    const result = await provider.spawn(baseRequest());
    assert.equal(result.type, "result");
    if (result.type !== "result") return;
    assert.ok(result.tokens);
    assert.equal(
      Object.prototype.hasOwnProperty.call(result.tokens, "cached"),
      false,
      "tokens.cached must be omitted (absent, not zero) on every result",
    );
  });

  it("does NOT thread agent_run_id into the client call", async () => {
    const fake = makeFakeClient(defaultResponse);
    const provider = createOllamaProvider({ client: fake.client });
    const req = baseRequest({
      agent_run_id: "agent-run-01HXSENTINELDEDUPETOKEN0000",
    });
    await provider.spawn(req);
    const args = fake.calls[0];
    assert.ok(args);
    // The captured call shape must not carry the sentinel agent_run_id
    // anywhere — Ollama has no native idempotency surface, so passing
    // it as a side-channel would be a no-op that mis-suggests retry
    // dedup. The capability matrix declares idempotent_spawn: false;
    // this test pins the no-dedup contract end-to-end.
    const serialized = JSON.stringify(args);
    assert.equal(
      serialized.includes(req.agent_run_id),
      false,
      `client call must not carry agent_run_id; got: ${serialized}`,
    );
  });

  it("falls back to {in:0, out:0} when token counters are absent", async () => {
    const fake = makeFakeClient({
      message: { role: "assistant", content: "hi" },
    });
    const provider = createOllamaProvider({ client: fake.client });
    const result = await provider.spawn(baseRequest());
    assert.equal(result.type, "result");
    if (result.type !== "result") return;
    assert.deepEqual(result.tokens, { in: 0, out: 0 });
  });

  it("returns an empty output string when message.content is null", async () => {
    const fake = makeFakeClient({
      message: { role: "assistant", content: null },
      prompt_eval_count: 0,
      eval_count: 0,
    });
    const provider = createOllamaProvider({ client: fake.client });
    const result = await provider.spawn(baseRequest());
    assert.equal(result.type, "result");
    if (result.type !== "result") return;
    assert.equal(result.output, "");
  });
});

describe("ollamaProvider (default singleton)", () => {
  // The "no network at module-eval" contract is verified by the test
  // file itself running to completion without a live Ollama instance —
  // the static import of ollamaProvider at the top of this file would
  // have thrown during module evaluation if the singleton eagerly
  // constructed the client. The assertion below is a shape-regression
  // guard: it pins that the singleton uses the same buildProvider
  // factory as createOllamaProvider, so the capability matrix cannot
  // drift between the two construction paths.
  it("mirrors the factory capability matrix on the singleton", () => {
    assert.equal(ollamaProvider.name, "ollama");
    assert.equal(ollamaProvider.capabilities.execution, "async");
    assert.equal(ollamaProvider.capabilities.idempotent_spawn, false);
    assert.equal(ollamaProvider.capabilities.reports_usage, true);
    assert.deepEqual(ollamaProvider.capabilities.features, []);
    assert.deepEqual(ollamaProvider.capabilities.models, []);
    assert.equal(ollamaProvider.capabilities.honors_mcp_whitelist, true);
    assert.deepEqual(ollamaProvider.agent_tools, []);
  });
});
