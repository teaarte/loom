// Code-bundle gate-policy resolver.
//
// The substrate's `on-blockers` / `auto` factories delegate the domain
// decision to this function: given a clean-enough state, what does the
// code domain want a gate to do? It is a pure function over the narrow
// state projection plus the policy context's pre-materialized accessors —
// no clock, no LLM call, no network. The substrate relies on that purity
// to replay a gate decision deterministically.
//
// Three roles, three postures:
//   - classify: trust the classifier; auto-approve.
//   - plan:     auto-reject (revise) while planning carries open CODE
//               blockers, else auto-approve.
//   - final:    auto-reject (revise) if acceptance failed or any blocking
//               CODE finding is still open, else auto-approve.
//
// `counts_against_replan_cap` is set on the auto-reject paths so a stuck
// revise loop is bounded by the substrate's replan budget rather than
// spinning forever.
//
// Harness blockers route to a HUMAN, never the rework loop. A harness
// blocker (e.g. an agent output the kernel could not parse) is not a fact
// about the code — re-running the implementer cannot resolve it, so
// auto-rejecting on it would spin implement → review until the replan cap
// escalated. Splitting the count by origin sends a harness blocker straight
// to a human (who can re-run the agent or force-close) while a code blocker
// still drives the bounded revise loop.

import type {
  BundleStateView,
  GatePolicyResolver,
  GatePolicyResult,
  GateRole,
  PolicyContext,
} from "@loomfsm/kernel";

function renderPlanFeedback(blockers: number): string {
  return `Plan has ${blockers} open blocking finding(s). Revise the plan to resolve them before implementation.`;
}

function renderFinalFeedback(
  acceptanceFailed: boolean,
  openBlockers: number,
): string {
  const parts: string[] = [];
  if (acceptanceFailed) parts.push("acceptance verdict is not a PASS");
  if (openBlockers > 0) parts.push(`${openBlockers} open blocking finding(s)`);
  return `Final checks did not clear: ${parts.join("; ")}. Address these and resubmit.`;
}

function renderHarnessFeedback(role: string, harnessBlockers: number): string {
  return (
    `${harnessBlockers} open harness blocker(s) at the ${role} gate — an agent's ` +
    `output could not be parsed/validated. This is an orchestration failure, ` +
    `not a code defect, so the implementer cannot resolve it. Re-run the affected ` +
    `agent (recovery: retry-failed) or force-close after inspecting the forensic row.`
  );
}

export const codePolicyResolver: GatePolicyResolver = (
  state: BundleStateView,
  role: GateRole,
  ctx: PolicyContext,
): GatePolicyResult => {
  if (role === "classify") {
    return { type: "auto-approve", reason: "code: classify trust" };
  }

  if (role === "plan") {
    // A harness blocker in planning routes to a human first — re-driving the
    // planner cannot fix an unparseable agent output.
    const harnessBlockers = ctx.findings.countBlocking({
      phase: "planning",
      origin: "harness",
    });
    if (harnessBlockers > 0) {
      return {
        type: "human-required",
        reason: `code: ${harnessBlockers} harness blocker(s) in planning`,
        feedback: renderHarnessFeedback("plan", harnessBlockers),
      };
    }
    const planBlockers = ctx.findings.countBlocking({
      phase: "planning",
      origin: "code",
    });
    if (planBlockers > 0) {
      return {
        type: "auto-reject",
        reason: `code: ${planBlockers} blocking finding(s) in planning`,
        reject_intent: "revise",
        feedback: renderPlanFeedback(planBlockers),
        counts_against_replan_cap: true,
      };
    }
    return { type: "auto-approve", reason: "code: plan clean" };
  }

  if (role === "final") {
    // Harness blockers (unparseable agent output, transport faults) cannot be
    // fixed by the rework loop — route them to a human instead of spinning
    // implement → review until the replan cap escalates.
    const harnessBlockers = ctx.findings.countBlocking({ origin: "harness" });
    if (harnessBlockers > 0) {
      return {
        type: "human-required",
        reason: `code: ${harnessBlockers} harness blocker(s) at final`,
        feedback: renderHarnessFeedback("final", harnessBlockers),
      };
    }
    const verdict = ctx.latest_verdict(state, "acceptance");
    const acceptanceFailed = verdict?.verdict === "FAIL";
    const openBlockers = ctx.findings.countBlocking({ origin: "code" });
    if (acceptanceFailed || openBlockers > 0) {
      return {
        type: "auto-reject",
        reason: "code: final safety floor",
        reject_intent: "revise",
        feedback: renderFinalFeedback(acceptanceFailed, openBlockers),
        counts_against_replan_cap: true,
      };
    }
    return { type: "auto-approve", reason: "code: final clean" };
  }

  return { type: "human-required", reason: `code: unknown role '${role}'` };
};
