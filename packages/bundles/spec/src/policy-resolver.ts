// Gate-policy resolver for the research/spec bundle.
//
// The substrate's `auto` factory delegates the domain decision here:
// given the generic state projection plus the policy context's
// pre-materialized accessors, what does this domain want a gate to do?
// It is a pure function over generic shapes — no clock, no LLM call, no
// network — so the substrate can replay the gate decision deterministically.
//
// The interesting property for a non-code domain: the rule is phrased
// entirely over GENERIC findings — "approve the specification unless a
// blocking defect is still open" — and names nothing about code, build,
// or tests. The substrate hands the resolver the same `findings` accessor
// it hands the code bundle; the meaning of a "blocking finding" is the
// bundle's (here: a spec defect that must be fixed before sign-off).
//
// `counts_against_replan_cap` is set on the auto-reject path so a stuck
// revise loop is bounded by the substrate's replan budget rather than
// spinning forever.

import type {
  BundleStateView,
  GatePolicyResolver,
  GatePolicyResult,
  GateRole,
  PolicyContext,
} from "@loomfsm/kernel";

function renderApprovalFeedback(openBlockers: number): string {
  return `The draft has ${openBlockers} open blocking defect(s). Resolve them before sign-off.`;
}

export const specPolicyResolver: GatePolicyResolver = (
  _state: BundleStateView,
  role: GateRole,
  ctx: PolicyContext,
): GatePolicyResult => {
  if (role === "spec-approval") {
    // A clean draft (no open blocking defect anywhere) earns sign-off; an
    // outstanding blocker sends the author back to revise. The count is a
    // generic read — the substrate does not know what a "defect" is.
    const openBlockers = ctx.findings.countBlocking({});
    if (openBlockers > 0) {
      return {
        type: "auto-reject",
        reason: `spec: ${openBlockers} open blocking defect(s)`,
        reject_intent: "revise",
        feedback: renderApprovalFeedback(openBlockers),
        counts_against_replan_cap: true,
      };
    }
    return { type: "auto-approve", reason: "spec: draft clean" };
  }

  // scope / consult ship the `human` posture, so the substrate never routes
  // them here; any other role is conservatively escalated to a human.
  return { type: "human-required", reason: `spec: unrouted role '${role}'` };
};
