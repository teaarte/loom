import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  Bundle,
  BundleStateView,
  Finding,
  FindingOrigin,
  FindingsAccess,
  NowToken,
  PolicyContext,
} from "@loomfsm/kernel";

import codeBundle from "../src/bundle.js";
import { codePolicyResolver } from "../src/policy-resolver.js";

const NOW = "2026-06-26T12:00:00.000Z" as NowToken;

function mkBlocker(phase: string, origin: FindingOrigin): { phase: string; finding: Finding } {
  return {
    phase,
    finding: {
      schema_version: "1.0",
      id: `f-${phase}-${origin}`,
      agent: origin === "harness" ? "unparseable" : "logic-reviewer",
      iteration: 1,
      task_id: "t-x",
      file: null,
      line_start: null,
      line_end: null,
      severity: "blocking",
      category: origin === "harness" ? "unparseable-output" : "correctness",
      proposed_new_category: null,
      pattern_id: null,
      summary: "blocker",
      evidence_excerpt: null,
      suggested_fix: null,
      status: "open",
      ref_rule_id: null,
      origin,
    },
  };
}

// FindingsAccess stub honoring the phase + origin filters the resolver uses.
function accessOf(rows: { phase: string; finding: Finding }[]): FindingsAccess {
  return {
    query: () => [],
    countBlocking(f) {
      return rows.filter(
        (r) =>
          (f?.phase === undefined || r.phase === f.phase) &&
          (f?.origin === undefined || (r.finding.origin ?? "code") === f.origin) &&
          r.finding.severity === "blocking" &&
          r.finding.status === "open",
      ).length;
    },
    queryByPhase: () => [],
  };
}

function ctxOf(
  rows: { phase: string; finding: Finding }[],
  opts: { acceptanceFail?: boolean } = {},
): PolicyContext {
  return {
    bundle: codeBundle as unknown as Bundle,
    findings: accessOf(rows),
    agents_query: { query: () => [] },
    latest_verdict: () =>
      opts.acceptanceFail
        ? ({ phase: "implementation", agent: "acceptance", iteration: 1, verdict: "FAIL" } as never)
        : null,
    rolePhase: () => null,
    now: NOW,
  };
}

const STATE = {
  agent_verdicts: [],
  files_modified: [],
  files_created: [],
  decisions: {},
} as unknown as BundleStateView;

describe("codePolicyResolver — harness vs code routing", async () => {
  it("final: a harness blocker routes to a human, not the rework loop", async () => {
    const ctx = ctxOf([mkBlocker("implementation", "harness")]);
    const d = await codePolicyResolver(STATE, "final", ctx);
    assert.equal(d.type, "human-required");
    // It must NOT count against the replan cap (that is the auto-reject loop
    // we are specifically avoiding for harness failures).
    assert.notEqual(d.type, "auto-reject");
  });

  it("final: a code blocker still drives the bounded revise loop", async () => {
    const ctx = ctxOf([mkBlocker("implementation", "code")]);
    const d = await codePolicyResolver(STATE, "final", ctx);
    assert.equal(d.type, "auto-reject");
    assert.equal(d.reject_intent, "revise");
    assert.equal(d.counts_against_replan_cap, true);
  });

  it("final: harness takes precedence when both kinds are open", async () => {
    const ctx = ctxOf([
      mkBlocker("implementation", "code"),
      mkBlocker("implementation", "harness"),
    ]);
    const d = await codePolicyResolver(STATE, "final", ctx);
    assert.equal(d.type, "human-required");
  });

  it("final: a clean state auto-approves", async () => {
    const d = await codePolicyResolver(STATE, "final", ctxOf([]));
    assert.equal(d.type, "auto-approve");
  });

  it("final: acceptance FAIL with no blockers still auto-rejects (code path)", async () => {
    const d = await codePolicyResolver(STATE, "final", ctxOf([], { acceptanceFail: true }));
    assert.equal(d.type, "auto-reject");
    assert.equal(d.reject_intent, "revise");
  });

  it("plan: a harness blocker in planning routes to a human", async () => {
    const ctx = ctxOf([mkBlocker("planning", "harness")]);
    const d = await codePolicyResolver(STATE, "plan", ctx);
    assert.equal(d.type, "human-required");
  });

  it("plan: a code blocker in planning auto-rejects (revise)", async () => {
    const ctx = ctxOf([mkBlocker("planning", "code")]);
    const d = await codePolicyResolver(STATE, "plan", ctx);
    assert.equal(d.type, "auto-reject");
    assert.equal(d.reject_intent, "revise");
  });
});
