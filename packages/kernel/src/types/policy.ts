// Gate-policy primitives.
//
// `Policy` is a pure function over (state, role, ctx). The kernel
// dispatcher has no switch over policy values — it simply calls the
// function. Named "presets" (`human`, `on-blockers`, `auto`, …) are
// stock factories that return Policy instances; the wire form is the
// `PolicyName` string carried on `PipelineState.gate_policies`.

import type { NowToken } from "./now.js";
import type { AgentVerdictRow, GateRole, Phase } from "./row-types.js";
import type { AgentRecordsAccess, FindingsAccess } from "./context.js";
import type { BundleStateView } from "./state.js";
import type { Bundle } from "./bundle.js";

// Wire-form policy name. Resolves to a `Policy` instance at registry
// load via the corresponding factory. Open string union so
// bundle-registered factories type-check alongside the three
// kernel-shipped names.
export type PolicyName = "human" | "on-blockers" | "auto" | (string & {});

// Pure function over (state, role, ctx). No `Date.now()`, no LLM calls,
// no network — the kernel relies on policies being replay-deterministic.
export type Policy = (
  state: BundleStateView,
  role: GateRole,
  ctx: PolicyContext,
) => GatePolicyResult | Promise<GatePolicyResult>;

export interface PolicyContext {
  bundle: Bundle;
  findings: FindingsAccess;
  agents_query: AgentRecordsAccess;
  latest_verdict(state: BundleStateView, agent: string): AgentVerdictRow | null;
  rolePhase(role: GateRole): Phase | null;
  // Identical to `state.now`; replicated on the context for call sites
  // that pass `ctx` without `state`.
  now: NowToken;
}

// Same shape as Policy. Static-analysis-enforced determinism contract:
// no `Date.now()` / `new Date()` / `Math.random()`, no LLM calls, no
// network I/O. The bundle-loader refuses resolvers that violate.
export type GatePolicyResolver = (
  state: BundleStateView,
  role: GateRole,
  ctx: PolicyContext,
) => GatePolicyResult | Promise<GatePolicyResult>;

export interface GatePolicyResult {
  type: "auto-approve" | "auto-reject" | "human-required";
  reason: string;
  feedback?: string;
  reject_intent?: "revise" | "abandon";
  counts_against_replan_cap?: boolean;
}
