// GateStage interpreter.
//
// 1. Build a `PolicyContext` from the StageContext (binds the pre-
//    materialized findings / agent-records / latest-verdict accessors).
// 2. Delegate role resolution + replan-cap enforcement + factory
//    dispatch to `resolveGatePolicy`. The interpreter does not
//    re-implement the cascade — adding a fourth factory or tweaking
//    the cap behavior is one place.
// 3. Switch on the decision:
//    - `human-required`: invoke `on_pre_ask` (if defined); if it
//      returns non-null pass that result through; otherwise emit
//      an `ask_user` directive carrying the gate's message and
//      valid_answers schema.
//    - `auto-approve` / `auto-reject`: synthesize a `UserAnswer`,
//      invoke `on_resume`, return whatever it produces.

import { resolveGatePolicy } from "../gate-policy.js";
import { makeGateEventId } from "../ids.js";
import { buildPolicyContext } from "../policies/index.js";
import type { StageContext } from "../types/context.js";
import type { GatePolicyResult } from "../types/policy.js";
import type { GateStage, StageResult } from "../types/plugins.js";
import type { PipelineState } from "../types/state.js";
import type { UserAnswer } from "../types/user-answer.js";

export async function interpretGate(
  stage: GateStage,
  state: PipelineState,
  ctx: StageContext,
): Promise<StageResult> {
  const policyCtx = buildPolicyContext(ctx);
  const decision: GatePolicyResult = await resolveGatePolicy(
    state,
    stage.name,
    policyCtx,
    ctx.registry,
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
    // Mint the gate_event_id here; the FSM tick persists it alongside the
    // pending answer so the matching user-answer delivery can be bound to
    // this exact ask (a mismatched id is refused as stale).
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
  // — alongside the answer-delivery surface); the on_resume return
  // value drives the FSM here.
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
