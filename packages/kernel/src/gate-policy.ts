// Gate-policy dispatcher.
//
// The FSM enters a GateStage; this resolver maps the gate name to a
// `GateRole` (identity-fallback when no mapping is registered), reads
// the active `PolicyName` from `state.gate_policies[role]` with `human`
// as the kernel-shipped baseline, applies the global auto-replan cap
// BEFORE the factory runs (so a bundle resolver returning auto-reject
// past the cap cannot loop forever), looks up the factory, and calls
// the resolved Policy against the narrowed `BundleStateView`.
//
// The cap check sits inside the dispatcher (not on the factory side)
// so adding a fourth policy is a factory file + one map entry — no
// per-factory boilerplate to enforce the kernel ceiling, no chance of
// a bundle-shipped factory forgetting to honor it.

import { narrowStateForBundle } from "./narrow.js";
import { KernelError } from "./state/db.js";
import { KERNEL_BUDGET_CEILINGS } from "./budgets.js";
import type { AttemptBudget } from "./types/budget.js";
import type { GatePolicyResult, PolicyContext } from "./types/policy.js";
import type { Registry } from "./types/registry.js";
import type { PipelineState } from "./types/state.js";

export async function resolveGatePolicy(
  state: PipelineState,
  gate: string,
  ctx: PolicyContext,
  registry: Registry,
): Promise<GatePolicyResult> {
  // Identity-fallback: when a bundle does not declare a role for this
  // gate the gate name itself serves as the role. Less brittle than
  // refusing to dispatch, and matches the dispatcher pseudocode used
  // by the gate-policy reference.
  const role = ctx.bundle.gate_roles?.[gate] ?? gate;

  const replanBudget: AttemptBudget = ctx.bundle.replan_budget ?? {
    kind: "attempt",
    max_iterations: 3,
    on_exhaustion: "human",
  };
  const cap = Math.min(
    replanBudget.max_iterations,
    replanBudget.kernel_ceiling ?? KERNEL_BUDGET_CEILINGS.replan,
  );
  const totalAutoRejections = sumValues(state.gate_auto_rejections);
  if (totalAutoRejections >= cap) {
    return budgetExhaustionToPolicy(replanBudget, cap, totalAutoRejections);
  }

  const policyName = state.gate_policies[role] ?? "human";
  const factory = registry.policyFactories.get(policyName);
  if (factory === undefined) {
    throw new KernelError({
      code: "POLICY_UNRESOLVED",
      message: `Unknown policy name '${policyName}' for role '${role}'`,
      detail: { policy_name: policyName, role },
    });
  }
  const policy = factory();
  const view = narrowStateForBundle(state, ctx.now);
  return policy(view, role, ctx);
}

function sumValues(m: Record<string, number>): number {
  return Object.values(m).reduce((a, b) => a + b, 0);
}

function budgetExhaustionToPolicy(
  budget: AttemptBudget,
  cap: number,
  total: number,
): GatePolicyResult {
  const reason = `auto-replan-capped at ${cap} (count=${total})`;
  switch (budget.on_exhaustion) {
    case "human":
      return { type: "human-required", reason };
    case "audit-only":
      return { type: "auto-approve", reason };
    case "abandon":
      return { type: "auto-reject", reason, reject_intent: "abandon" };
    default: {
      const _exhaustive: never = budget.on_exhaustion;
      return _exhaustive;
    }
  }
}
