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

import { getKernelTx } from "../fsm.js";
import { resolveGatePolicy } from "../gate-policy.js";
import { makeGateEventId } from "../ids.js";
import { clearBlockerStall, evaluateBlockerStall } from "../lib/blocker-stall.js";
import {
  clearOpenBlockers,
  snapshotOpenBlockers,
  supersedeFindingsOnWalkBack,
} from "../lib/supersede-findings.js";
import { buildPolicyContext } from "../policies/index.js";
import { assertVocabKnown } from "../vocabularies.js";
import type { StageContext } from "../types/context.js";
import type { GatePolicyResult } from "../types/policy.js";
import type { GateStage, StageResult } from "../types/plugins.js";
import type { PipelineState } from "../types/state.js";
import type { Transaction } from "../types/transaction.js";
import type { UserAnswer } from "../types/user-answer.js";

export async function interpretGate(
  stage: GateStage,
  state: PipelineState,
  ctx: StageContext,
): Promise<StageResult> {
  const policyCtx = buildPolicyContext(ctx);
  let decision: GatePolicyResult = await resolveGatePolicy(
    state,
    stage.name,
    policyCtx,
    ctx.registry,
  );

  // Per-blocker stall breaker. An auto-reject that would walk back gets its
  // live code-blocker set fingerprinted; when the SAME set recurs unchanged
  // for STALL_THRESHOLD rounds the loop is not converging, so escalate to a
  // human rather than re-driving the implementer against a blocker it cannot
  // clear. Fires earlier than the global replan cap (the tighter, more
  // specific guard) and composes with it: a stall converts the decision to
  // human-required BEFORE the cap-counting bump below, so a stalled round is
  // not also charged against the replan budget.
  if (decision.type === "auto-reject" && decision.counts_against_replan_cap === true) {
    const stall = await evaluateBlockerStall(getKernelTx(ctx), state.driver.scratch);
    state.driver.scratch = stall.scratch;
    if (stall.stalled) {
      decision = {
        type: "human-required",
        reason: `stall-breaker: blocker set unchanged across ${stall.count} consecutive rework rounds`,
        feedback: stall.feedback,
      };
    }
  }

  // An auto-reject that asked to count against the replan cap must record
  // itself, or the cap (read from pipeline_gate_counters.auto_rejections)
  // never advances and a persistent blocker spins the auto-reject → walk-back
  // loop forever. The dispatcher reads this counter BEFORE the factory next
  // tick, so once it reaches the budget the gate escalates to a human
  // instead of hanging. Bumped inside this gate's tx; mirrored in memory so
  // a same-pass re-entry sees it too.
  if (decision.type === "auto-reject" && decision.counts_against_replan_cap === true) {
    const role = ctx.bundle.gate_roles?.[stage.name] ?? stage.name;
    await bumpAutoRejection(getKernelTx(ctx), role);
    state.gate_auto_rejections[role] = (state.gate_auto_rejections[role] ?? 0) + 1;
  }

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
  // act on. An auto-decided gate never takes the user-answer delivery
  // path, so the `gates` row + audit are written HERE (mirroring the
  // human path's row) — otherwise an auto-approved / auto-rejected gate
  // would leave a counter but no audit/display row. `decided_by` is
  // validated against the registered decider vocabulary, the same
  // insert-time discipline the human path applies. The on_resume return
  // value drives the FSM below.
  const autoStatus = decision.type === "auto-approve" ? "auto-approved" : "auto-rejected";
  assertVocabKnown(ctx.registry.vocabularies.decided_by, "auto-policy", "decided_by");
  await writeAutoGateRow(getKernelTx(ctx), stage.name, autoStatus, decision.feedback ?? null, ctx.now);

  const answer: UserAnswer = decision.type === "auto-approve"
    ? { decision: "accept" }
    : autoRejectAnswer(decision);

  const result: StageResult = !stage.on_resume
    ? // Default resume policy: auto-approve advances; auto-reject
      // walks back to the gate's own name (which becomes a no-op in
      // most flows but is the safe default — bundles supply their
      // own resume to do anything more nuanced).
      answer.decision === "accept"
      ? { type: "advance" }
      : { type: "walk_back_to", step: stage.name, reason: "auto-reject without bundle-supplied on_resume" }
    : await stage.on_resume(ctx.state, answer, ctx);

  // A policy-driven walk-back is a replan: retire the prior round's live
  // findings across every phase the flow re-runs, co-committed in THIS
  // gate tx alongside the gate row + auto-rejection counter (the same
  // once-per-decision durable record). The human-answer walk-back gets the
  // mirror treatment on its own delivery tx. Skipped when the target is
  // not in the flow — the FSM loop surfaces that as WALK_BACK_TARGET_NOT_FOUND
  // and must not see a half-applied supersede.
  if (result.type === "walk_back_to") {
    const flow = ctx.registry.flows.get(state.driver.flow_name);
    const target = flow ? flow.indexOf(result.step) : -1;
    if (flow && target >= 0 && target <= state.driver.step_index) {
      // Hand the rejecting round's open blockers to the re-entered flow BEFORE
      // they are retired — captured into the scratch the supersede write below
      // then carries forward, so the snapshot is not dropped. The next spawn
      // renders them under "### Open blockers" so the fixer knows what to
      // address; gating still reads the live findings table, not this snapshot.
      state.driver.scratch = await snapshotOpenBlockers(getKernelTx(ctx), state.driver.scratch);
      // Mirror the bumped per-phase counters onto the in-memory snapshot
      // so the re-run pass stamps bundle-pushed findings under the new
      // round (delivery-path stamping re-reads scratch from disk anyway).
      state.driver.scratch = await supersedeFindingsOnWalkBack(getKernelTx(ctx), {
        flow,
        stages: ctx.registry.stages,
        targetIndex: target,
        currentIndex: state.driver.step_index,
        scratch: state.driver.scratch,
      });
    }
  } else if (result.type === "advance") {
    // A gate approval settles the blockers the last rejection handed off —
    // drop the snapshot so a downstream spawn does not list resolved blockers,
    // and reset the stall counter so a later unrelated reject starts fresh.
    state.driver.scratch = await clearOpenBlockers(getKernelTx(ctx), state.driver.scratch);
    state.driver.scratch = await clearBlockerStall(getKernelTx(ctx), state.driver.scratch);
  }
  return result;
}

// Record the auto-decided gate row inside the gate tx. UPSERT on the
// gate name (a re-entered gate that flips its auto verdict overwrites the
// prior row) so a walk-back loop leaves one current row per gate, the
// same shape the human path's UPSERT produces.
async function writeAutoGateRow(
  tx: Transaction,
  gate: string,
  status: "auto-approved" | "auto-rejected",
  feedback: string | null,
  now: string,
): Promise<void> {
  await tx.exec(
    "INSERT INTO gates (name, status, decided_by, feedback, decided_at) " +
      "VALUES (?, ?, 'auto-policy', ?, ?) " +
      "ON CONFLICT(name) DO UPDATE SET " +
      "status = excluded.status, decided_by = excluded.decided_by, " +
      "feedback = excluded.feedback, decided_at = excluded.decided_at",
    [gate, status, feedback, now],
  );
}

// Increment the per-role auto-rejection counter. The row is seeded on the
// first auto-reject for the role; later ticks bump it. This is the value the
// dispatcher sums against the replan budget ceiling.
async function bumpAutoRejection(tx: Transaction, role: string): Promise<void> {
  await tx.exec(
    "INSERT INTO pipeline_gate_counters (role, human_revisions, auto_rejections) " +
      "VALUES (?, 0, 1) " +
      "ON CONFLICT(role) DO UPDATE SET auto_rejections = auto_rejections + 1",
    [role],
  );
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
