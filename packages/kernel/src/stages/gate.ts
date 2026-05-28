// GateStage interpreter.
//
// 1. Resolve the gate's role via `bundle.gate_roles[stage.name]`.
//    Missing → halt with `GATE_ROLE_UNKNOWN` (the bundle-loader
//    will surface the same error at load when it gains full bundle
//    validation; the interpreter still checks because the unloaded
//    surface is the path under test for now).
// 2. Resolve the active PolicyName: `state.gate_policies[role]`
//    falls back to "human". Resolve the factory via
//    `registry.policyFactories.get(name)()`; missing factory →
//    halt with `POLICY_FACTORY_UNKNOWN`.
// 3. Call the policy. Synchronous + async both work.
//    - `human-required`: invoke `on_pre_ask` (if defined); if it
//      returns non-null pass that result through; otherwise emit
//      an `ask_user` directive carrying the gate's message and
//      valid_answers schema.
//    - `auto-approve` / `auto-reject`: synthesize a `UserAnswer`,
//      invoke `on_resume`, return whatever it produces.

import { makeGateEventId } from "../ids.js";
import type { StageContext } from "../types/context.js";
import type { GatePolicyResult, PolicyContext } from "../types/policy.js";
import type { GateStage, StageResult } from "../types/plugins.js";
import type { PipelineState } from "../types/state.js";
import type { UserAnswer } from "../types/user-answer.js";

export async function interpretGate(
  stage: GateStage,
  _state: PipelineState,
  ctx: StageContext,
): Promise<StageResult> {
  const role = ctx.bundle.gate_roles[stage.name];
  if (role === undefined) {
    return {
      type: "halt",
      directive: {
        code: "GATE_ROLE_UNKNOWN",
        message: `GateStage '${stage.name}' has no role mapping in bundle.gate_roles`,
        recovery_options: [],
      },
    };
  }

  const policyName = ctx.state.gate_policies[role] ?? "human";
  const factory = ctx.registry.policyFactories.get(policyName);
  if (factory === undefined) {
    return {
      type: "halt",
      directive: {
        code: "POLICY_FACTORY_UNKNOWN",
        message: `policyFactories has no entry for '${policyName}' (role='${role}')`,
        recovery_options: [],
      },
    };
  }

  const policyCtx: PolicyContext = {
    bundle: ctx.bundle,
    findings: ctx.findings,
    agents_query: ctx.agents_query,
    latest_verdict: (_state, agent) => {
      const matches = ctx.state.agent_verdicts.filter(
        (v) => v.agent === agent,
      );
      return matches.length > 0
        ? (matches[matches.length - 1] ?? null)
        : null;
    },
    rolePhase: (_role) => null,
    now: ctx.now,
  };
  const policy = factory();
  const decision: GatePolicyResult = await Promise.resolve(
    policy(ctx.state, role, policyCtx),
  );

  if (decision.type === "human-required") {
    if (stage.on_pre_ask) {
      const pre = await Promise.resolve(stage.on_pre_ask(ctx.state, ctx));
      if (pre !== null && pre !== undefined) {
        return pre;
      }
    }
    const message = await Promise.resolve(stage.message(ctx.state));
    const valid_answers = await Promise.resolve(stage.valid_answers(ctx.state));
    return {
      type: "ask_user",
      directive: {
        gate: stage.name,
        gate_event_id: makeGateEventId(),
        message,
        valid_answers,
      },
    };
  }

  // Auto path: synthesize a UserAnswer the bundle's on_resume can
  // act on. The gate_decision audit + the gate-row write land via
  // the user-answer delivery path (handled out of this interpreter
  // — landing alongside the answer-delivery surface); the
  // on_resume return value drives the FSM here.
  const answer: UserAnswer = decision.type === "auto-approve"
    ? { decision: "accept" }
    : autoRejectAnswer(decision);

  if (!stage.on_resume) {
    // Default resume policy: auto-approve advances; auto-reject
    // walks back to the gate's own name (which becomes a no-op in
    // most flows but is the safe default — bundles supply their
    // own resume to do anything more nuanced).
    if (answer.decision === "accept") return { type: "advance" };
    return { type: "walk_back_to", step: stage.name, reason: "auto-reject without bundle-supplied on_resume" };
  }
  return stage.on_resume(ctx.state, answer, ctx);
}

function autoRejectAnswer(decision: GatePolicyResult): UserAnswer {
  const out: UserAnswer = { decision: "reject" };
  if (decision.reject_intent !== undefined) {
    out.reject_intent = decision.reject_intent;
  }
  if (decision.feedback !== undefined) {
    out.message = decision.feedback;
  }
  return out;
}
