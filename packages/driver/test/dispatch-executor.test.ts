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

import type { ProviderShuttleIntent } from "@loomfsm/kernel";

import { createDispatchExecutor, type Executor, type ExecutorResult } from "../src/index.js";

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
