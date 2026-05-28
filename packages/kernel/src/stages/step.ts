// StepStage interpreter — positional path only.
//
// Marker-style Steps (`effects: []`, no `run`) advance silently —
// they exist purely as walk-back targets and visibility milestones.
// Compute-style Steps (with a `run` body) mutate kernel state via
// `ctx.tx` (BundleScratchTx); the FSM drains the BundleOp[] buffer
// after this returns. A `run` body throwing aborts the outer tx via
// the kernel's atomic-write contract — invariants on commit catch
// what the body alone cannot.
//
// Event-position Steps (`position: "event"`) are NOT in flow[] and
// never reach this switch — `dispatchEventSteps` handles them in
// response to kernel events. Refuse the bad shape loudly.

import type { StageContext } from "../types/context.js";
import type { StageResult, StepStage } from "../types/plugins.js";
import type { PipelineState } from "../types/state.js";

export async function interpretStep(
  stage: StepStage,
  _state: PipelineState,
  ctx: StageContext,
): Promise<StageResult> {
  if (stage.position !== "positional") {
    return {
      type: "halt",
      directive: {
        code: "STEP_EVENT_IN_FLOW",
        message: `StepStage '${stage.name}' has position='event' but appears in a flow; event-position Steps must not be in flow[]`,
        recovery_options: [],
      },
    };
  }

  if (stage.applies_to && !stage.applies_to(ctx.state)) {
    return { type: "advance" };
  }

  if (stage.run) {
    await stage.run(ctx.state, ctx);
  }
  return { type: "advance" };
}
