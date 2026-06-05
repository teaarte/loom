// The per-spawn dispatch shell routes each spawn to the executor the resolver
// returns for it, stays backend-blind, and reports idempotent re-execution so
// the resume restart-head behaves exactly as the single-executor model did.
//
// Coverage:
//   * a mixed drive — one spawn routed to backend A, another to backend B —
//     reaches the right sub-executor and returns its result;
//   * the resolver may be async (a probe / credential read);
//   * idempotent defaults to true and is overridable.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { KernelError, type ProviderShuttleIntent } from "@loomfsm/kernel";

import { createDispatchExecutor, type ChainEntry, type Executor, type ExecutorResult } from "../src/index.js";

function intent(overrides: Partial<ProviderShuttleIntent> = {}): ProviderShuttleIntent {
  return {
    agent: "agent-a",
    agent_run_id: "ar-01HX0000000000000000000000",
    phase: "review",
    model: "default",
    prompt: "decide",
    ...overrides,
  };
}

// A sub-executor that stamps which backend ran (proves routing without a real
// backend).
function tagExecutor(tag: string): Executor {
  return {
    async execute(spawn: ProviderShuttleIntent): Promise<ExecutorResult> {
      return { agent_output: `${tag}:${spawn.agent}` };
    },
  };
}

describe("createDispatchExecutor — per-spawn routing", () => {
  it("routes each spawn to the executor the resolver returns (mixed backends in one drive)", async () => {
    const cc = tagExecutor("cc");
    const raw = tagExecutor("raw");
    const seen: string[] = [];

    const dispatch = createDispatchExecutor({
      resolveExecutor: (spawn) => {
        // Stand-in for the real family→backend→executor resolution the CLI owns.
        seen.push(spawn.agent);
        return spawn.agent === "agent-b" ? raw : cc;
      },
    });

    const a = await dispatch.execute(intent({ agent: "agent-a" }));
    const b = await dispatch.execute(intent({ agent: "agent-b" }));

    assert.equal(a.agent_output, "cc:agent-a");
    assert.equal(b.agent_output, "raw:agent-b");
    assert.deepEqual(seen, ["agent-a", "agent-b"]);
  });

  it("awaits an async resolver (a backend probe / credential read)", async () => {
    const dispatch = createDispatchExecutor({
      resolveExecutor: async (spawn) => {
        await Promise.resolve();
        return tagExecutor(`async-${spawn.phase}`);
      },
    });
    const out = await dispatch.execute(intent({ phase: "adjudication" }));
    assert.equal(out.agent_output, "async-adjudication:agent-a");
  });

  it("defaults idempotent to true and honors an explicit override", () => {
    assert.equal(createDispatchExecutor({ resolveExecutor: () => tagExecutor("x") }).idempotent, true);
    assert.equal(
      createDispatchExecutor({ resolveExecutor: () => tagExecutor("x"), idempotent: false }).idempotent,
      false,
    );
  });
});

// An executor that fails with a given code N times, then succeeds (tags itself).
function flakyExecutor(tag: string, failCode: string | null, times = Infinity): Executor & { calls: number } {
  let calls = 0;
  return {
    calls: 0,
    async execute(spawn: ProviderShuttleIntent): Promise<ExecutorResult> {
      calls += 1;
      (this as { calls: number }).calls = calls;
      if (failCode !== null && calls <= times) {
        throw new KernelError({ code: failCode, message: `${tag} failed`, detail: {} });
      }
      return { agent_output: `${tag}:${spawn.model}` };
    },
  };
}

describe("createDispatchExecutor — per-agent fallback chain", () => {
  it("advances to the next backend on a rate-limit, running the fallback's model", async () => {
    const primary = flakyExecutor("primary", "EXECUTOR_RATE_LIMITED");
    const fallback = flakyExecutor("fallback", null);
    const notices: string[] = [];
    const dispatch = createDispatchExecutor({
      resolveExecutorChain: (): ChainEntry[] => [
        { executor: primary, label: "anthropic:opus" },
        { executor: fallback, model: "qwen/coder", label: "openrouter:qwen" },
      ],
      onNotice: (m) => notices.push(m),
    });
    const out = await dispatch.execute(intent());
    // The fallback ran, with ITS model (the override), not the primary's.
    assert.equal(out.agent_output, "fallback:qwen/coder");
    assert.equal(primary.calls, 1);
    assert.equal(fallback.calls, 1);
    assert.match(notices[0] ?? "", /falling back to openrouter:qwen/);
  });

  it("advances on a permanent provider error (bad model id)", async () => {
    const primary = flakyExecutor("primary", "EXECUTOR_INVALID_MODEL");
    const fallback = flakyExecutor("fallback", null);
    const dispatch = createDispatchExecutor({
      resolveExecutorChain: (): ChainEntry[] => [
        { executor: primary },
        { executor: fallback, model: "m2" },
      ],
    });
    const out = await dispatch.execute(intent());
    assert.equal(out.agent_output, "fallback:m2");
  });

  it("does NOT advance on a generic failure (left to the loop's same-backend retry)", async () => {
    const primary = flakyExecutor("primary", "EXECUTOR_FAILED");
    const fallback = flakyExecutor("fallback", null);
    const dispatch = createDispatchExecutor({
      resolveExecutorChain: (): ChainEntry[] => [{ executor: primary }, { executor: fallback, model: "m2" }],
    });
    await assert.rejects(
      () => dispatch.execute(intent()),
      (e: unknown) => e instanceof KernelError && e.code === "EXECUTOR_FAILED",
    );
    assert.equal(fallback.calls, 0, "a generic failure must not consume the fallback");
  });

  it("re-throws the last error when the whole chain is exhausted (→ the loop parks)", async () => {
    const a = flakyExecutor("a", "EXECUTOR_RATE_LIMITED");
    const b = flakyExecutor("b", "EXECUTOR_AUTH_FAILED");
    const dispatch = createDispatchExecutor({
      resolveExecutorChain: (): ChainEntry[] => [{ executor: a }, { executor: b, model: "m2" }],
    });
    await assert.rejects(
      () => dispatch.execute(intent()),
      (e: unknown) => e instanceof KernelError && e.code === "EXECUTOR_AUTH_FAILED",
    );
    assert.equal(a.calls, 1);
    assert.equal(b.calls, 1);
  });

  it("throws NO_BACKEND_RESOLVED on an empty chain", async () => {
    const dispatch = createDispatchExecutor({ resolveExecutorChain: (): ChainEntry[] => [] });
    await assert.rejects(
      () => dispatch.execute(intent()),
      (e: unknown) => e instanceof KernelError && e.code === "NO_BACKEND_RESOLVED",
    );
  });
});
