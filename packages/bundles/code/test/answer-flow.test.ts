// The answer flow — the bundle side of an INFORMATIONAL task: the classifier
// routes `complexity=question` to a no-edit flow whose responder answers and
// whose apply-answer step lands the answer where the operator reads a finished
// task's outcome. Unit-level over the real registered stage bodies (scratch
// façade only, same pattern as the checks suite).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BundleStateView, NowToken, StageContext } from "@loomfsm/kernel";

import codeBundle from "../src/bundle.js";
import { CODE_BUNDLE_AGENT_EXECUTION } from "../src/agent-execution.js";

const NOW = "2026-06-12T10:00:00.000Z" as NowToken;

interface Captured {
  bundle_state: Record<string, unknown>;
  decisions: Record<string, unknown>;
  audits: Record<string, unknown>[];
}

async function runStage(
  name: string,
  state: Partial<BundleStateView>,
): Promise<Captured> {
  const cap: Captured = { bundle_state: {}, decisions: {}, audits: [] };
  const ctx = {
    now: NOW,
    tx: {
      set_bundle_state_field: (p: string, v: unknown) => {
        cap.bundle_state[p] = v;
      },
      set_decision: (k: string, v: unknown) => {
        cap.decisions[k] = v;
      },
      audit: (payload: Record<string, unknown>) => {
        cap.audits.push(payload);
      },
    },
  } as unknown as StageContext;
  const stage = codeBundle.stages[name];
  assert.ok(stage !== undefined && stage.kind === "step" && stage.run !== undefined);
  await stage.run(state as BundleStateView, ctx);
  return cap;
}

describe("@loomfsm/bundle-code — answer flow", () => {
  it("routes complexity=question to the answer flow, which never spawns an editing agent", () => {
    assert.equal(codeBundle.complexity_flows?.map["question"], "answer");
    const flow = codeBundle.flows["answer"];
    assert.ok(flow !== undefined, "the answer flow is declared");
    // Shared switch prefix — the kernel's flow switch lands here aligned.
    assert.deepEqual(flow.slice(0, 4), [
      "initialize",
      "classify",
      "classify-agent",
      "stack-to-bundle-state",
    ]);
    // No stage in the flow spawns an agent the bundle declares as file-editing
    // — the empty-diff guard has nothing to fire on, structurally.
    for (const stageName of flow) {
      const stage = codeBundle.stages[stageName];
      if (stage?.kind !== "spawn") continue;
      assert.notEqual(
        CODE_BUNDLE_AGENT_EXECUTION[stage.agent],
        "agentic",
        `answer-flow spawn '${stageName}' must not run a file-editing agent`,
      );
    }
  });

  it("apply-answer lands the responder's answer; finish-summary prefers it verbatim", async () => {
    const answer = "Run `docker compose up backend`, then `pnpm dev` — see `README.md:42`.";
    const applied = await runStage("apply-answer", {
      decisions: { answer },
    });
    assert.equal(applied.bundle_state["answer"], answer);
    assert.equal(applied.decisions["answer"], true);
    assert.deepEqual(applied.audits, [{ type: "answer-recorded", answered: true }]);

    const summary = await runStage("finish-summary", {
      decisions: {},
      bundle_state: { answer },
      files_created: [],
      files_modified: [],
    });
    assert.equal(summary.bundle_state["completion_summary"], answer);
  });

  it("a responder that recorded nothing still finishes with an honest summary", async () => {
    const applied = await runStage("apply-answer", { decisions: {} });
    assert.match(String(applied.bundle_state["answer"]), /recorded no answer/);
    assert.equal(applied.decisions["answer"], false);
  });

  it("a non-answer task's finish-summary still derives from the file accounting", async () => {
    const summary = await runStage("finish-summary", {
      task: "add a helper module",
      decisions: { complexity: "simple" },
      bundle_state: {},
      files_created: ["src/a.ts"],
      files_modified: [],
    });
    assert.match(String(summary.bundle_state["completion_summary"]), /1 new/);
  });
});
