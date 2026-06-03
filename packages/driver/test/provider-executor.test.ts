// The provider-backed (plain, single-shot) executor: it runs an async provider
// in-process, passes the provider's tokens through as per-spawn usage, refuses a
// shuttle-only provider, and classifies a recognised thrown error as the
// surfaceable EXECUTOR_RATE_LIMITED so the supervisor waits instead of escalating.
//
// No network: a stub LLMProvider stands in for a real backend so the executor's
// own mapping is exercised offline (the real raw-API path is proven by a
// throwaway live spike, not a unit test).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { KernelError } from "@loomfsm/kernel";
import type {
  LLMProvider,
  ProviderResult,
  ProviderSpawnRequest,
} from "@loomfsm/kernel";

import { createProviderExecutor, type SpawnUsage } from "../src/index.js";

function asyncProvider(
  name: string,
  spawn: (req: ProviderSpawnRequest) => Promise<ProviderResult>,
): LLMProvider {
  return {
    name,
    capabilities: {
      execution: "async",
      idempotent_spawn: true,
      reports_usage: true,
      features: [],
      models: [],
      honors_mcp_whitelist: true,
    },
    agent_tools: [],
    spawn,
  };
}

function req(): ProviderSpawnRequest {
  return {
    agent: "decider",
    agent_run_id: "ar-01HX0000000000000000000000",
    phase: "review",
    model: "some-model",
    prompt: "ACCEPT or REJECT?",
  };
}

describe("createProviderExecutor — plain single-shot backend", () => {
  it("returns the text and passes provider tokens through as usage + onUsage", async () => {
    let sunk: SpawnUsage | undefined;
    const provider = asyncProvider("p", async () => ({
      type: "result",
      output: "ACCEPT",
      tokens: { in: 12, out: 3, cached: 1 },
    }));
    const exec = createProviderExecutor(provider, { onUsage: (u) => (sunk = u) });

    const result = await exec.execute(req());

    assert.equal(result.agent_output, "ACCEPT");
    // Plain executor: no worktree, no file delta.
    assert.equal(result.files_modified, undefined);
    assert.equal(result.files_created, undefined);
    // Usage rides on the result AND reaches the sink.
    assert.deepEqual(result.usage, { tokens: { in: 12, out: 3, cached: 1 } });
    assert.deepEqual(sunk, { tokens: { in: 12, out: 3, cached: 1 } });
  });

  it("omits usage when the provider reports no tokens", async () => {
    const provider = asyncProvider("p", async () => ({ type: "result", output: "REJECT" }));
    const result = await createProviderExecutor(provider).execute(req());
    assert.equal(result.agent_output, "REJECT");
    assert.equal(result.usage, undefined);
  });

  it("finalizes a streaming result into text + usage", async () => {
    const provider = asyncProvider("p", async () => ({
      type: "stream",
      stream: (async function* () {})(),
      finalize: async () => ({ output: "streamed", tokens: { in: 5, out: 2 } }),
    }));
    const result = await createProviderExecutor(provider).execute(req());
    assert.equal(result.agent_output, "streamed");
    assert.deepEqual(result.usage, { tokens: { in: 5, out: 2 } });
  });

  it("classifies a detected thrown error as EXECUTOR_RATE_LIMITED (the supervisor waits)", async () => {
    // Mirrors the real ollama error shape captured in the spike:
    // { name:"ResponseError", status_code:number, error:string }.
    const rateLimitErr = Object.assign(new Error("rate limited"), { status_code: 429 });
    const provider = asyncProvider("ollama-ish", async () => {
      throw rateLimitErr;
    });
    const exec = createProviderExecutor(provider, {
      detectRateLimit: (err) =>
        typeof err === "object" && err !== null && (err as { status_code?: number }).status_code === 429,
    });

    await assert.rejects(
      () => exec.execute(req()),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal(err.code, "EXECUTOR_RATE_LIMITED");
        return true;
      },
    );
  });

  it("re-throws an unrecognised error unchanged (the loop wraps it as EXECUTOR_FAILED)", async () => {
    const boom = new Error("connection reset");
    const provider = asyncProvider("p", async () => {
      throw boom;
    });
    const exec = createProviderExecutor(provider, { detectRateLimit: () => false });
    await assert.rejects(() => exec.execute(req()), /connection reset/);
  });

  it("refuses a shuttle-only provider (no host in the headless loop)", async () => {
    const shuttle: LLMProvider = {
      name: "shuttle-only",
      capabilities: {
        execution: "shuttle",
        idempotent_spawn: false,
        reports_usage: false,
        features: [],
        models: [],
        honors_mcp_whitelist: true,
      },
      spawn: async (request) => ({
        type: "shuttle",
        intent: {
          agent: request.agent,
          agent_run_id: request.agent_run_id,
          phase: request.phase,
          model: request.model,
          prompt: request.prompt,
        },
      }),
    };
    await assert.rejects(
      () => createProviderExecutor(shuttle).execute(req()),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal(err.code, "PROVIDER_NOT_HEADLESS");
        return true;
      },
    );
  });
});
