// Resume-form re-emit — re-derive the directive a paused task is currently
// waiting on, WITHOUT mutating state or advancing past the pause. This is
// the restart head every transport shares: the stdio `pipeline_resume`
// tool and the headless loop both call it to re-attach to a dropped task.
//
// Order matters: pending agents are checked BEFORE the runFSM fallback
// because a blind re-tick would re-enter the spawn stage and mint fresh
// agent_run_ids (tripping the duplicate-window guard); the pending path
// re-shuttles the EXISTING rows instead, reusing each agent_run_id, so a
// re-delivery dedups through the idempotency ledger.

import {
  buildRetryFailedDirective,
  KernelError,
  narrowStateForBundle,
  runFSM,
  type KernelDirective,
  type PipelineState,
  type Registry,
} from "@loomfsm/kernel";

export async function resumeDirective(
  state: PipelineState,
  registry: Registry,
): Promise<KernelDirective> {
  if (state.pending_agents.length > 0) {
    const agentRunIds = state.pending_agents.map((row) => row.agent_run_id);
    return buildRetryFailedDirective(state, registry, agentRunIds);
  }
  if (state.driver.pending_user_answer !== null) {
    return reEmitAsk(state, registry);
  }
  const { directive } = await runFSM(state, registry);
  return directive;
}

// Reconstruct the ask-user directive for a task parked at a human gate.
// The persisted pending answer carries gate / message / gate_event_id but
// NOT valid_answers (the schema is not stored), so it cannot be re-emitted
// from state alone. Re-derive message + valid_answers from the gate stage's
// own pure callbacks — exactly what the gate interpreter calls — and stamp
// the PERSISTED gate_event_id (NOT a fresh one) so the answer the host
// eventually delivers still binds to this exact ask. Fully read-only: the
// narrowing helper and both callbacks are side-effect-free by contract.
function reEmitAsk(state: PipelineState, registry: Registry): Promise<KernelDirective> {
  const pending = state.driver.pending_user_answer;
  // The caller guards pending !== null; this keeps the type honest.
  if (pending === null) {
    throw new KernelError({
      code: "KERNEL_INVARIANT",
      message: "reEmitAsk called with no pending user answer",
    });
  }
  const stage = registry.stages.get(pending.gate);
  if (stage === undefined || stage.kind !== "gate") {
    throw new KernelError({
      code: "STAGE_NOT_REGISTERED",
      message: `gate stage '${pending.gate}' is not registered; cannot re-emit its ask`,
      detail: { gate: pending.gate },
    });
  }
  const view = narrowStateForBundle(state, state.now);
  return (async () => {
    const message = await Promise.resolve(stage.message(view));
    const valid_answers = await Promise.resolve(stage.valid_answers(view));
    return {
      kind: "ask-user",
      driver_state_id: state.driver_state_id,
      gate: pending.gate,
      gate_event_id: pending.gate_event_id,
      message,
      valid_answers,
    };
  })();
}
