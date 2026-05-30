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
//   - plan:     auto-reject (revise) while planning carries open blockers,
//               else auto-approve.
//   - final:    auto-reject (revise) if acceptance failed or any blocking
//               finding is still open, else auto-approve.
//
// `counts_against_replan_cap` is set on the auto-reject paths so a stuck
// revise loop is bounded by the substrate's replan budget rather than
// spinning forever.

import type {
  BundleStateView,
  GatePolicyResolver,
  GatePolicyResult,
  GateRole,
  PolicyContext,
} from "@loom/kernel";

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

export const codePolicyResolver: GatePolicyResolver = (
  state: BundleStateView,
  role: GateRole,
  ctx: PolicyContext,
): GatePolicyResult => {
  if (role === "classify") {
    return { type: "auto-approve", reason: "code: classify trust" };
  }

  if (role === "plan") {
    const planBlockers = ctx.findings.countBlocking({ phase: "planning" });
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
    const verdict = ctx.latest_verdict(state, "acceptance");
    const acceptanceFailed = verdict?.verdict === "FAIL";
    const openBlockers = ctx.findings.countBlocking({});
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
