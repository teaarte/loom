// Kernel-shipped stock policy factories + helpers that bind a
// `PolicyContext` and a `policyFactoryRegistry` for the gate dispatcher.
//
// The three factories below match the literal shape described in the
// gate-policy contract:
//   - `human()`       always returns `human-required`.
//   - `onBlockers()`  human-required iff `findings.countBlocking({phase})
//                     > 0`; otherwise delegates to the bundle resolver
//                     (or auto-approves when no resolver is registered).
//   - `bundle()`      delegates directly to the bundle resolver; when
//                     the resolver is missing returns a defensive
//                     human-required (the bundle-loader will refuse a
//                     bundle that ships this without a resolver, so the
//                     branch is unreachable in production).
//
// Adding a fourth factory is a new file + one entry in
// `buildPolicyFactoryRegistry`; the dispatcher does NOT switch on policy
// values, so the lookup stays a one-liner.

import type { StageContext } from "../types/context.js";
import type { Bundle } from "../types/bundle.js";
import type {
  GatePolicyResult,
  Policy,
  PolicyContext,
  PolicyName,
} from "../types/policy.js";
import type { GateRole, Phase } from "../types/row-types.js";
import { KernelError } from "../state/db.js";

// ============================================================================
// Stock factories
// ============================================================================

function humanFactory(): Policy {
  return (_state, role, _ctx): GatePolicyResult => ({
    type: "human-required",
    reason: `policy[${role}]=human`,
  });
}

function onBlockersFactory(): Policy {
  return async (state, role, ctx): Promise<GatePolicyResult> => {
    const phase = ctx.rolePhase(role);
    const filter = phase === null ? {} : { phase };
    const blockers = ctx.findings.countBlocking(filter);
    if (blockers > 0) {
      return {
        type: "human-required",
        reason: `${blockers} open blocking finding(s)`,
      };
    }
    if (ctx.bundle.policyResolver) {
      return ctx.bundle.policyResolver(state, role, ctx);
    }
    return { type: "auto-approve", reason: "on-blockers: clean state" };
  };
}

function bundleFactory(): Policy {
  return async (state, role, ctx): Promise<GatePolicyResult> => {
    if (!ctx.bundle.policyResolver) {
      // Bundle-loader refuses a bundle that ships `policies.bundle()`
      // (wire-form name `"auto"`) without a resolver, so this branch
      // is unreachable once the loader gate is in place. The defensive
      // human-required keeps the runtime safe in the meantime.
      return {
        type: "human-required",
        reason: "auto policy without bundle resolver — safe default",
      };
    }
    return ctx.bundle.policyResolver(state, role, ctx);
  };
}

export const policies = {
  human: humanFactory,
  onBlockers: onBlockersFactory,
  bundle: bundleFactory,
};

// ============================================================================
// buildPolicyFactoryRegistry — kernel-shipped seeds + bundle-registered merges
// ============================================================================

// Wire-form name → factory. The kernel hard-codes three names
// (`human`, `on-blockers`, `auto`). A bundle may add more via
// `bundle.policy_factories`; collisions on a kernel-shipped name are
// rejected — bundles cannot shadow the substrate's vocabulary.
export function buildPolicyFactoryRegistry(
  bundle: Bundle,
): Map<PolicyName, () => Policy> {
  const m = new Map<PolicyName, () => Policy>([
    ["human", humanFactory],
    ["on-blockers", onBlockersFactory],
    ["auto", bundleFactory],
  ]);
  const extra: Record<string, () => Policy> = bundle.policy_factories ?? {};
  for (const name of Object.keys(extra)) {
    const factory = extra[name];
    if (factory === undefined) continue;
    if (m.has(name)) {
      throw new KernelError({
        code: "POLICY_NAME_COLLISION",
        message: `Bundle redefines kernel-shipped policy '${name}'`,
        detail: { policy_name: name },
      });
    }
    m.set(name as PolicyName, factory);
  }
  return m;
}

// ============================================================================
// derivedRolePhase — scan bundle.stages for a gate that owns the role
// ============================================================================

// Returns the phase of the FIRST gate stage in registration order
// whose `gate_roles[stage.name] === role`. When no gate maps the role,
// returns null — `on-blockers` then calls `findings.countBlocking({})`
// (no phase filter), counting every open blocker.
export function derivedRolePhase(
  bundle: Bundle,
  role: GateRole,
): Phase | null {
  for (const [stageName, stage] of Object.entries(bundle.stages)) {
    if (stage.kind !== "gate") continue;
    if (bundle.gate_roles[stageName] === role) {
      return stage.phase;
    }
  }
  return null;
}

// ============================================================================
// buildPolicyContext — assemble the PolicyContext from a StageContext
// ============================================================================

// Hoisted out of the inline closure inside the GateStage interpreter so
// callers outside the interpreter (recovery primitive, replay surface)
// can build a PolicyContext from a StageContext without copy-pasting
// the closure body. The access surfaces (`findings`, `agents_query`)
// reuse the pre-materialized impls bound on the StageContext — no
// extra SELECTs.
export function buildPolicyContext(ctx: StageContext): PolicyContext {
  const bundle = ctx.bundle;
  return {
    bundle,
    findings: ctx.findings,
    agents_query: ctx.agents_query,
    latest_verdict: (s, agent) => {
      const matches = s.agent_verdicts.filter((v) => v.agent === agent);
      return matches.length > 0
        ? (matches[matches.length - 1] ?? null)
        : null;
    },
    rolePhase: (role) => derivedRolePhase(bundle, role),
    now: ctx.now,
  };
}
