import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProviderSpawnRequest } from "@loomfsm/kernel";

import {
  createOpenRouterProvider,
  openRouterProvider,
  type OpenRouterChatCompletionArgs,
  type OpenRouterChatCompletionOptions,
  type OpenRouterChatCompletionResponse,
  type OpenRouterClientLike,
} from "../src/index.js";

function baseRequest(
  overrides: Partial<ProviderSpawnRequest> = {},
): ProviderSpawnRequest {
  return {
    agent: "writer",
    agent_run_id: "agent-run-01HX0000000000000000000000",
    phase: "implementation",
    model: "anthropic/claude-opus-4",
    system_prompt: "you are a helpful assistant",
    prompt: "draft a poem",
    ...overrides,
  };
}

interface FakeClient {
  client: OpenRouterClientLike;
  calls: OpenRouterChatCompletionArgs[];
  options: (OpenRouterChatCompletionOptions | undefined)[];
}

function makeFakeClient(response: OpenRouterChatCompletionResponse): FakeClient {
  const calls: OpenRouterChatCompletionArgs[] = [];
  const options: (OpenRouterChatCompletionOptions | undefined)[] = [];
  const client: OpenRouterClientLike = {
    chat: {
      completions: {
        create(args, opts) {
          calls.push(args);
          options.push(opts);
          return Promise.resolve(response);
        },
      },
    },
  };
  return { client, calls, options };
}

const defaultResponse: OpenRouterChatCompletionResponse = {
  choices: [{ message: { role: "assistant", content: "hello" } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

describe("createOpenRouterProvider", () => {
  it("declares the documented capability matrix", () => {
    const { client } = makeFakeClient(defaultResponse);
    const provider = createOpenRouterProvider({ client });
    assert.equal(provider.name, "openrouter");
    assert.equal(provider.capabilities.execution, "async");
    assert.equal(provider.capabilities.idempotent_spawn, true);
    assert.equal(provider.capabilities.reports_usage, true);
    assert.deepEqual(provider.capabilities.features, []);
    assert.deepEqual(provider.capabilities.models, []);
    assert.equal(provider.capabilities.honors_mcp_whitelist, true);
    assert.deepEqual(provider.agent_tools, []);
  });

  it("forwards model, max_tokens default, and idempotencyKey to the client", async () => {
    const fake = makeFakeClient(defaultResponse);
    const provider = createOpenRouterProvider({ client: fake.client });
    const req = baseRequest();
    await provider.spawn(req);
    assert.equal(fake.calls.length, 1);
    const args = fake.calls[0];
    assert.ok(args);
    assert.equal(args.model, req.model);
    assert.equal(args.max_tokens, 4096);
    assert.equal(fake.options[0]?.idempotencyKey, req.agent_run_id);
  });

  it("includes the system message when system_prompt is present", async () => {
    const fake = makeFakeClient(defaultResponse);
    const provider = createOpenRouterProvider({ client: fake.client });
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
    const provider = createOpenRouterProvider({ client: fake.client });
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

  it("extracts output and tokens, and never populates tokens.cached", async () => {
    const fake = makeFakeClient({
      choices: [{ message: { role: "assistant", content: "hello" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const provider = createOpenRouterProvider({ client: fake.client });
    const result = await provider.spawn(baseRequest());
    assert.equal(result.type, "result");
    if (result.type !== "result") return;
    assert.equal(result.output, "hello");
    assert.deepEqual(result.tokens, { in: 10, out: 5 });
    assert.ok(result.tokens);
    assert.equal(
      Object.prototype.hasOwnProperty.call(result.tokens, "cached"),
      false,
      "tokens.cached must be omitted (absent, not zero) on every result",
    );
  });

  it("throws EXECUTOR_OUTPUT_TRUNCATED (a coded, sqlite-free error) when finish_reason is 'length'", async () => {
    const fake = makeFakeClient({
      choices: [{ message: { role: "assistant", content: "a cut-off answer" }, finish_reason: "length" }],
      usage: { prompt_tokens: 10, completion_tokens: 4096 },
    });
    const provider = createOpenRouterProvider({ client: fake.client });
    await assert.rejects(
      provider.spawn(baseRequest()),
      (err: unknown) => (err as { code?: string }).code === "EXECUTOR_OUTPUT_TRUNCATED",
    );
  });

  it("does not throw when finish_reason is the normal 'stop'", async () => {
    const fake = makeFakeClient({
      choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const provider = createOpenRouterProvider({ client: fake.client });
    const result = await provider.spawn(baseRequest());
    assert.equal(result.type, "result");
  });

  it("returns an empty output string when message.content is null", async () => {
    const fake = makeFakeClient({
      choices: [{ message: { role: "assistant", content: null } }],
      usage: { prompt_tokens: 4, completion_tokens: 0 },
    });
    const provider = createOpenRouterProvider({ client: fake.client });
    const result = await provider.spawn(baseRequest());
    assert.equal(result.type, "result");
    if (result.type !== "result") return;
    assert.equal(result.output, "");
  });

  it("reads only choices[0] when the response carries multiple choices", async () => {
    const fake = makeFakeClient({
      choices: [
        { message: { role: "assistant", content: "first" } },
        { message: { role: "assistant", content: "second" } },
      ],
      usage: { prompt_tokens: 6, completion_tokens: 2 },
    });
    const provider = createOpenRouterProvider({ client: fake.client });
    const result = await provider.spawn(baseRequest());
    assert.equal(result.type, "result");
    if (result.type !== "result") return;
    assert.equal(result.output, "first");
  });

  it("falls back to {in:0, out:0} when the response omits usage", async () => {
    const fake = makeFakeClient({
      choices: [{ message: { role: "assistant", content: "hi" } }],
    });
    const provider = createOpenRouterProvider({ client: fake.client });
    const result = await provider.spawn(baseRequest());
    assert.equal(result.type, "result");
    if (result.type !== "result") return;
    assert.deepEqual(result.tokens, { in: 0, out: 0 });
  });

  it("honors req.extras.max_tokens when supplied as a positive number, otherwise falls back to 4096", async () => {
    const fake = makeFakeClient(defaultResponse);
    const provider = createOpenRouterProvider({ client: fake.client });
    await provider.spawn(baseRequest({ extras: { max_tokens: 2048 } }));
    assert.equal(fake.calls[0]?.max_tokens, 2048);

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
        args.max_tokens,
        4096,
        `expected 4096 fallback at call ${i}; got ${args.max_tokens}`,
      );
    }
  });
});

describe("openRouterProvider (default singleton)", () => {
  // The contract: importing the module must NOT throw when
  // OPENROUTER_API_KEY is absent — bundle-loaders / static analysis
  // tools import the package without the env var set, and only actual
  // spawn() usage should require credentials. The two assertions below
  // pin this jointly: (1) the singleton is a non-throwing reference at
  // module-eval time; (2) the first spawn() call surfaces a typed
  // error when the env var is unset.
  it("exposes a singleton without throwing at module-eval time", () => {
    assert.equal(openRouterProvider.name, "openrouter");
    assert.equal(openRouterProvider.capabilities.execution, "async");
  });

  it("defers the OPENROUTER_API_KEY check to the first spawn() call", async () => {
    const prior = process.env["OPENROUTER_API_KEY"];
    delete process.env["OPENROUTER_API_KEY"];
    try {
      await assert.rejects(
        openRouterProvider.spawn({
          agent: "writer",
          agent_run_id: "agent-run-01HX0000000000000000000000",
          phase: "implementation",
          model: "anthropic/claude-opus-4",
          prompt: "p",
        }),
        /OPENROUTER_API_KEY is not set/,
      );
    } finally {
      if (prior !== undefined) process.env["OPENROUTER_API_KEY"] = prior;
    }
  });
});
