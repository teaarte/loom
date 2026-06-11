// Deterministic pre-review checks — the bundle side: the apply-checks Step
// reads the executor's envelope into bundle_state + findings + the reviewer
// self-gate; the safety floor treats a skipped check as passing; and a failed
// check drives the gate's auto-reject (walk-back). Unit-level over the real
// registered stage / agent / invariant / resolver bodies — no FSM harness, no
// mocked database (these run bodies touch only the scratch façade).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FINDING_ID_PATTERN } from "@loomfsm/kernel";
import type {
  BundleStateView,
  Finding,
  GateRole,
  NowToken,
  PolicyContext,
  StageContext,
} from "@loomfsm/kernel";

import codeBundle from "../src/bundle.js";
import { codePolicyResolver } from "../src/policy-resolver.js";
import { invLintClean, invTestsPass, invTypecheckClean } from "../src/invariants.js";

const NOW = "2026-06-11T10:00:00.000Z" as NowToken;

interface CapturedChecks {
  bundle_state: Record<string, unknown>;
  decisions: Record<string, unknown>;
  findings: Finding[];
  audits: Record<string, unknown>[];
}

// Run the registered `apply-checks` Step over a decisions.checks envelope,
// capturing everything it writes through the scratch façade.
async function runApplyChecks(checks: unknown, taskId = "t-2026-06-11-x"): Promise<CapturedChecks> {
  const cap: CapturedChecks = { bundle_state: {}, decisions: {}, findings: [], audits: [] };
  const state = {
    task_id: taskId,
    decisions: { checks },
  } as unknown as BundleStateView;
  const ctx = {
    now: NOW,
    tx: {
      set_bundle_state_field: (p: string, v: unknown) => { cap.bundle_state[p] = v; },
      set_decision: (k: string, v: unknown) => { cap.decisions[k] = v; },
      record_finding: (f: Finding) => { cap.findings.push(f); },
      audit: (payload: Record<string, unknown>) => { cap.audits.push(payload); },
    },
  } as unknown as StageContext;
  const stage = codeBundle.stages["apply-checks"];
  assert.ok(stage !== undefined && stage.kind === "step" && stage.run !== undefined);
  await stage.run(state, ctx);
  return cap;
}

describe("@loomfsm/bundle-code — apply-checks reads the executor envelope", () => {
  it("a failed check → fail status, a blocking finding carrying the output, checks_ok=false", async () => {
    const out = "src/foo.ts(12,5): error TS2345: Argument of type 'string' is not assignable.";
    const cap = await runApplyChecks([
      { name: "typecheck", status: "fail", exit_code: 2, output_tail: out, command: "pnpm run typecheck" },
      { name: "lint", status: "ok", exit_code: 0 },
      { name: "test", status: "skipped" },
    ]);

    // bundle_state mirrors each check into the field the safety floor reads.
    assert.equal((cap.bundle_state["typecheck"] as { status: string }).status, "fail");
    assert.equal((cap.bundle_state["typecheck"] as { exit_code: number }).exit_code, 2);
    assert.equal((cap.bundle_state["lint_result"] as { status: string }).status, "ok");
    assert.equal((cap.bundle_state["test_run"] as { status: string }).status, "skipped");

    // Exactly one blocking finding, attributed to the checks runner, carrying
    // the command + the compiler output (so the open-blocker hand-off delivers
    // it to the implementer on the walk-back).
    assert.equal(cap.findings.length, 1);
    const f = cap.findings[0]!;
    assert.equal(f.severity, "blocking");
    assert.equal(f.category, "failed-check");
    assert.equal(f.status, "open");
    assert.match(f.id, FINDING_ID_PATTERN);
    assert.match(f.summary, /typecheck check failed/);
    assert.match(f.summary, /exited 2/);
    assert.ok((f.suggested_fix ?? "").includes("error TS2345"), "output rides in suggested_fix");

    // The reviewer self-gate is off, and the bulky envelope is compacted.
    assert.equal(cap.decisions["checks_ok"], false);
    assert.deepEqual(cap.decisions["checks"], { ok: false, failed: ["typecheck"] });
    assert.deepEqual(cap.audits, [{ type: "checks-recorded", ok: false, failed: ["typecheck"] }]);
  });

  it("clamps a huge output into the finding fields (schema caps respected)", async () => {
    const out = "E".repeat(50_000);
    const cap = await runApplyChecks([
      { name: "test", status: "fail", exit_code: 1, output_tail: out, command: "node --test" },
    ]);
    const f = cap.findings[0]!;
    assert.ok((f.summary ?? "").length <= 200);
    assert.ok((f.suggested_fix ?? "").length <= 300);
    assert.ok((f.evidence_excerpt ?? "").length <= 400);
  });

  it("all green → checks_ok=true, no findings", async () => {
    const cap = await runApplyChecks([
      { name: "typecheck", status: "ok", exit_code: 0 },
      { name: "lint", status: "ok", exit_code: 0 },
      { name: "test", status: "ok", exit_code: 0 },
    ]);
    assert.equal(cap.findings.length, 0);
    assert.equal(cap.decisions["checks_ok"], true);
    assert.deepEqual(cap.decisions["checks"], { ok: true, failed: [] });
  });

  it("a missing/empty envelope → every check skipped, no findings, checks_ok=true", async () => {
    const cap = await runApplyChecks(undefined);
    assert.equal(cap.findings.length, 0);
    assert.equal(cap.decisions["checks_ok"], true);
    for (const field of ["typecheck", "lint_result", "test_run"]) {
      assert.equal((cap.bundle_state[field] as { status: string }).status, "skipped");
    }
  });

  it("distinct rework rounds (different NowToken) mint distinct finding ids", async () => {
    const failing = [{ name: "typecheck", status: "fail", exit_code: 2, output_tail: "boom", command: "tsc" }];
    const a = await runApplyChecks(failing);
    // Re-run with a later tick `now` — a persistent failure must re-block, not
    // collide with the superseded prior-round finding.
    const cap = a; // round 1 id
    const round1Id = cap.findings[0]!.id;
    const ctx2Now = "2026-06-11T11:30:00.000Z" as NowToken;
    const cap2: CapturedChecks = { bundle_state: {}, decisions: {}, findings: [], audits: [] };
    const state2 = { task_id: "t", decisions: { checks: failing } } as unknown as BundleStateView;
    const ctx2 = {
      now: ctx2Now,
      tx: {
        set_bundle_state_field: () => {},
        set_decision: () => {},
        record_finding: (f: Finding) => { cap2.findings.push(f); },
        audit: () => {},
      },
    } as unknown as StageContext;
    const stage = codeBundle.stages["apply-checks"];
    assert.ok(stage !== undefined && stage.kind === "step" && stage.run !== undefined);
    await stage.run(state2, ctx2);
    assert.notEqual(round1Id, cap2.findings[0]!.id);
  });
});

// ============================================================================
// reviewers self-gate off a broken round (the review fanout does NOT run)
// ============================================================================

describe("@loomfsm/bundle-code — reviewers skip when checks failed", () => {
  function reviewerApplies(name: string, decisions: Record<string, unknown>): boolean {
    const agent = codeBundle.agents.find((a) => a.name === name);
    assert.ok(agent?.applies_to !== undefined, `agent '${name}' must declare applies_to`);
    const state = {
      decisions,
      agent_verdicts: [],
      files_modified: [],
    } as unknown as BundleStateView;
    return agent.applies_to(state);
  }

  it("checks_ok=false drops every implementation-review agent", () => {
    for (const name of [
      "logic-reviewer", "challenger-reviewer", "style-reviewer", "security",
      "performance", "ui-consistency", "api-contract", "playwright",
    ]) {
      assert.equal(
        reviewerApplies(name, { checks_ok: false, source_changed: true, ui_touched: true, api_touched: true, security_needed: true }),
        false,
        `${name} must not run on a failed-checks round`,
      );
    }
  });

  it("checks_ok=true (or unset, e.g. planning) lets a reviewer run", () => {
    assert.equal(reviewerApplies("logic-reviewer", { checks_ok: true, source_changed: true }), true);
    // Unset (no checks have run yet — plan-review during planning) must not block.
    assert.equal(reviewerApplies("logic-reviewer", { source_changed: true }), true);
  });
});

// ============================================================================
// the safety floor accepts a skipped check (only fail / missing blocks auto)
// ============================================================================

describe("@loomfsm/bundle-code — floor treats skipped as passing", () => {
  function floorState(field: string, value: unknown): BundleStateView {
    return {
      bundle_state: { [field]: value },
      gate_policies: { final: "auto" },
      gates: { "gate-final": { status: "auto-approved", decided_by: "policy" } },
    } as unknown as BundleStateView;
  }
  const snaps = {} as never;

  it("a skipped check passes every floor invariant under auto", () => {
    const skipped = { status: "skipped" };
    assert.equal(invLintClean(floorState("lint_result", skipped), snaps), null);
    assert.equal(invTestsPass(floorState("test_run", skipped), snaps), null);
    assert.equal(invTypecheckClean(floorState("typecheck", skipped), snaps), null);
  });

  it("a failed check still vetoes a full-autonomous final approve", () => {
    const failed = { status: "fail" };
    assert.equal(invLintClean(floorState("lint_result", failed), snaps)?.code, "INV_lint_clean");
    assert.equal(invTestsPass(floorState("test_run", failed), snaps)?.code, "INV_tests_pass");
    assert.equal(invTypecheckClean(floorState("typecheck", failed), snaps)?.code, "INV_typecheck_clean");
  });
});

// ============================================================================
// a failed check drives the final gate's auto-reject (the walk-back)
// ============================================================================

describe("@loomfsm/bundle-code — failed check walks back at the final gate", () => {
  function policyCtx(openBlockers: number): PolicyContext {
    return {
      findings: { countBlocking: () => openBlockers, query: () => [], queryByPhase: () => [] },
      latest_verdict: () => null,
      agents_query: { query: () => [] },
      rolePhase: () => null,
      now: NOW,
    } as unknown as PolicyContext;
  }

  it("an open blocking finding → auto-reject (revise), counted against the replan cap", async () => {
    const state = { agent_verdicts: [] } as unknown as BundleStateView;
    const decision = await codePolicyResolver(state, "final" as GateRole, policyCtx(1));
    assert.equal(decision.type, "auto-reject");
    assert.equal(decision.type === "auto-reject" ? decision.reject_intent : undefined, "revise");
    assert.equal(decision.type === "auto-reject" ? decision.counts_against_replan_cap : undefined, true);
  });

  it("no open blockers → auto-approve", async () => {
    const state = { agent_verdicts: [] } as unknown as BundleStateView;
    const decision = await codePolicyResolver(state, "final" as GateRole, policyCtx(0));
    assert.equal(decision.type, "auto-approve");
  });
});

// ============================================================================
// the checks stages are wired into every flow, before review
// ============================================================================

describe("@loomfsm/bundle-code — checks stages sit before review in every flow", () => {
  it("run-checks + apply-checks follow git-diff and precede any review", () => {
    for (const flow of ["simple", "medium", "complex"]) {
      const steps = codeBundle.flows[flow] ?? [];
      const diff = steps.indexOf("git-diff");
      const run = steps.indexOf("run-checks");
      const apply = steps.indexOf("apply-checks");
      assert.ok(diff >= 0 && run === diff + 1 && apply === run + 1, `flow '${flow}' must run checks right after git-diff`);
      for (const reviewStage of ["pre-review", "review", "review-deep", "review-light"]) {
        const idx = steps.indexOf(reviewStage);
        if (idx >= 0) assert.ok(apply < idx, `flow '${flow}': checks must precede '${reviewStage}'`);
      }
    }
  });

  it("trivial runs the checks after git-diff (no review round to loop with)", () => {
    const steps = codeBundle.flows["trivial"] ?? [];
    assert.deepEqual(steps.slice(-3), ["run-checks", "apply-checks", "finalize"]);
  });

  it("the old test-verify stub is gone", () => {
    assert.equal(codeBundle.stages["test-verify"], undefined);
    for (const flow of Object.values(codeBundle.flows)) {
      assert.ok(!flow.includes("test-verify"));
    }
  });
});
