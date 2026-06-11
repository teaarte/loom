import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProviderSpawnRequest } from "@loomfsm/kernel";

import {
  createAnthropicSdkProvider,
  type AnthropicMessageCreateArgs,
  type AnthropicMessageCreateOptions,
  type AnthropicMessageResponse,
  type AnthropicSdkClientLike,
} from "../src/index.js";

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

interface FakeClient {
  client: AnthropicSdkClientLike;
  calls: AnthropicMessageCreateArgs[];
  options: (AnthropicMessageCreateOptions | undefined)[];
}

function makeFakeClient(response: AnthropicMessageResponse): FakeClient {
  const calls: AnthropicMessageCreateArgs[] = [];
  const options: (AnthropicMessageCreateOptions | undefined)[] = [];
  const client: AnthropicSdkClientLike = {
    messages: {
      create(args, opts) {
        calls.push(args);
        options.push(opts);
        return Promise.resolve(response);
      },
    },
  };
  return { client, calls, options };
}

const defaultResponse: AnthropicMessageResponse = {
  content: [{ type: "text", text: "hello" }],
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
};

describe("createAnthropicSdkProvider", () => {
  it("declares the documented capability matrix", () => {
    const { client } = makeFakeClient(defaultResponse);
    const provider = createAnthropicSdkProvider({ client });
    assert.equal(provider.name, "anthropic-sdk");
    assert.equal(provider.capabilities.execution, "async");
    assert.equal(provider.capabilities.idempotent_spawn, true);
    assert.equal(provider.capabilities.reports_usage, true);
    assert.deepEqual(provider.capabilities.features, ["prompt_caching"]);
    assert.deepEqual(provider.capabilities.models, []);
    assert.equal(provider.capabilities.honors_mcp_whitelist, true);
    assert.deepEqual(provider.agent_tools, []);
  });

  it("forwards model, max_tokens default, and idempotencyKey to the client", async () => {
    const fake = makeFakeClient(defaultResponse);
    const provider = createAnthropicSdkProvider({ client: fake.client });
    const req = baseRequest();
    await provider.spawn(req);
    assert.equal(fake.calls.length, 1);
    const args = fake.calls[0];
    assert.ok(args);
    assert.equal(args.model, req.model);
    assert.equal(args.max_tokens, 4096);
    assert.equal(fake.options[0]?.idempotencyKey, req.agent_run_id);
  });

  it("passes the cache-shaped payload to the client", async () => {
    const fake = makeFakeClient(defaultResponse);
    const provider = createAnthropicSdkProvider({ client: fake.client });
    const req = baseRequest({ system_prompt: "you are X", prompt: "do Y" });
    await provider.spawn(req);
    const args = fake.calls[0];
    assert.ok(args);
    assert.deepEqual(args.system, [
      {
        type: "text",
        text: "you are X",
        cache_control: { type: "ephemeral" },
      },
    ]);
    assert.deepEqual(args.messages, [
      { role: "user", content: [{ type: "text", text: "do Y" }] },
    ]);
  });

  it("extracts text output and reports tokens.in / out / cached", async () => {
    const fake = makeFakeClient({
      content: [
        { type: "text", text: "hello " },
        { type: "tool_use" },
        { type: "text", text: "world" },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 3,
      },
    });
    const provider = createAnthropicSdkProvider({ client: fake.client });
    const result = await provider.spawn(baseRequest());
    assert.equal(result.type, "result");
    if (result.type !== "result") return;
    assert.equal(result.output, "hello world");
    assert.deepEqual(result.tokens, { in: 10, out: 5, cached: 3 });
  });

  it("omits tokens.cached when cache_read_input_tokens is zero", async () => {
    const fake = makeFakeClient({
      content: [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: 7,
        output_tokens: 2,
        cache_read_input_tokens: 0,
      },
    });
    const provider = createAnthropicSdkProvider({ client: fake.client });
    const result = await provider.spawn(baseRequest());
    assert.equal(result.type, "result");
    if (result.type !== "result") return;
    assert.ok(result.tokens);
    assert.equal(
      Object.prototype.hasOwnProperty.call(result.tokens, "cached"),
      false,
      "tokens.cached must be omitted when no cache hit occurred",
    );
    assert.equal(result.tokens.in, 7);
    assert.equal(result.tokens.out, 2);
  });

  it("honors req.extras.max_tokens when supplied as a positive number", async () => {
    const fake = makeFakeClient(defaultResponse);
    const provider = createAnthropicSdkProvider({ client: fake.client });
    await provider.spawn(baseRequest({ extras: { max_tokens: 2048 } }));
    const args = fake.calls[0];
    assert.ok(args);
    assert.equal(args.max_tokens, 2048);
  });

  it("omits args.system when req.system_prompt is absent", async () => {
    const fake = makeFakeClient(defaultResponse);
    const provider = createAnthropicSdkProvider({ client: fake.client });
    await provider.spawn(baseRequest({ system_prompt: undefined }));
    const args = fake.calls[0];
    assert.ok(args);
    assert.equal(
      Object.prototype.hasOwnProperty.call(args, "system"),
      false,
      "args.system must be absent (not undefined) when system_prompt is omitted",
    );
  });

  it("falls back to the 4096 default for non-positive / non-finite / non-number extras.max_tokens", async () => {
    const fake = makeFakeClient(defaultResponse);
    const provider = createAnthropicSdkProvider({ client: fake.client });
    const cases: Record<string, unknown>[] = [
      { max_tokens: 0 },
      { max_tokens: -1 },
      { max_tokens: Number.NaN },
      { max_tokens: Number.POSITIVE_INFINITY },
      { max_tokens: "8192" },
    ];
    for (const extras of cases) {
      await provider.spawn(baseRequest({ extras }));
    }
    assert.equal(fake.calls.length, cases.length);
    for (const args of fake.calls) {
      assert.equal(
        args.max_tokens,
        4096,
        `expected 4096 fallback; got ${args.max_tokens}`,
      );
    }
  });

  it("surfaces cache_creation_input_tokens out-of-band as cache_write (cost roll-up counts it)", async () => {
    const fake = makeFakeClient({
      content: [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 40,
      },
    });
    const provider = createAnthropicSdkProvider({ client: fake.client });
    const result = await provider.spawn(baseRequest());
    assert.equal(result.type, "result");
    if (result.type !== "result") return;
    // cache-READ stays on the kernel `tokens` shape; cache-WRITE rides
    // out-of-band (the kernel models only cache-read), like OpenRouter's cost.
    assert.deepEqual(result.tokens, { in: 10, out: 5, cached: 3 });
    assert.equal((result as { cache_write?: number }).cache_write, 40);
  });

  it("omits cache_write out-of-band when cache_creation_input_tokens is zero / absent", async () => {
    const fake = makeFakeClient(defaultResponse); // no cache_creation_input_tokens
    const provider = createAnthropicSdkProvider({ client: fake.client });
    const result = await provider.spawn(baseRequest());
    assert.equal(result.type, "result");
    if (result.type !== "result") return;
    assert.equal(
      Object.prototype.hasOwnProperty.call(result, "cache_write"),
      false,
      "cache_write must be absent (never a fabricated zero) when no prefix was written",
    );
  });

  it("throws EXECUTOR_OUTPUT_TRUNCATED (a coded, sqlite-free error) when stop_reason is max_tokens", async () => {
    const fake = makeFakeClient({
      content: [{ type: "text", text: "a partial, cut-off answer" }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 10, output_tokens: 4096 },
    });
    const provider = createAnthropicSdkProvider({ client: fake.client });
    await assert.rejects(
      provider.spawn(baseRequest()),
      (err: unknown) => (err as { code?: string }).code === "EXECUTOR_OUTPUT_TRUNCATED",
    );
  });

  it("does not throw when stop_reason is the normal end_turn", async () => {
    const fake = makeFakeClient({
      content: [{ type: "text", text: "complete" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const provider = createAnthropicSdkProvider({ client: fake.client });
    const result = await provider.spawn(baseRequest());
    assert.equal(result.type, "result");
  });

  it("omits tokens.cached when cache_read_input_tokens is missing from the response", async () => {
    const fake = makeFakeClient({
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 4, output_tokens: 1 },
    });
    const provider = createAnthropicSdkProvider({ client: fake.client });
    const result = await provider.spawn(baseRequest());
    assert.equal(result.type, "result");
    if (result.type !== "result") return;
    assert.ok(result.tokens);
    assert.equal(
      Object.prototype.hasOwnProperty.call(result.tokens, "cached"),
      false,
      "tokens.cached must be omitted when the response did not carry the field",
    );
  });
});
