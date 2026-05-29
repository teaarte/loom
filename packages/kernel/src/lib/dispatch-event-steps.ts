// Dispatcher for event-position `StepStage`s.
//
// `dispatchEventSteps(event, ctx, tx, ops)` walks every registered
// `StepStage` whose `position === "event"` and whose declared `event`
// + `filter` match the firing event, then invokes its `run(state,
// ctx)` body INSIDE the caller's open transaction. Each Step's
// returned `BundleOp[]` is drained between runs so a later Step sees
// the prior Step's effects, and a throw out of any `run` body
// propagates upward — `withStateTransaction` rolls back the whole
// tx, leaving no half-mutated state.
//
// There is no `bundleHost` RPC in this revision — Steps run in-
// process. The worker-thread fence (when it ships) plugs in here
// without changing call sites; the contract is just "produce a
// BundleOp[] buffer the kernel applies".

import { applyBundleOps } from "./apply-bundle-ops.js";
import type { BundleOp, StageContext } from "../types/context.js";
import type { HookEvent, StepStage } from "../types/plugins.js";
import type { Phase } from "../types/row-types.js";
import type { Transaction } from "../types/transaction.js";

export async function dispatchEventSteps(
  event: HookEvent,
  ctx: StageContext,
  tx: Transaction,
  ops: BundleOp[],
  phase: Phase = "",
): Promise<void> {
  const matches: StepStage[] = [];
  for (const stage of ctx.registry.stages.values()) {
    if (stage.kind !== "step") continue;
    if (stage.position !== "event") continue;
    if (stage.event === undefined) continue;
    if (!eventNameMatches(stage.event, event)) continue;
    if (!filterMatches(stage.filter, ctx)) continue;
    matches.push(stage);
  }

  for (const step of matches) {
    if (step.applies_to && !step.applies_to(ctx.state)) continue;
    if (step.run) {
      await step.run(ctx.state, ctx);
    }
    // Drain whatever this Step pushed before the next Step runs —
    // ordering matters when two event-Steps subscribe to the same
    // event and depend on each other's writes. The active phase is
    // threaded so a finding the Step buffers lands under it.
    if (ops.length > 0) {
      await applyBundleOps(tx, ops, phase);
      ops.length = 0;
    }
  }
}

function eventNameMatches(declared: HookEvent, actual: HookEvent): boolean {
  // Step.event is typed as the open HookEvent string union — string
  // equality is the only meaningful match. RegExp event matching
  // lives on `Hook.event` (post-commit subscribers); event-position
  // Steps target a single named event by design.
  return declared === actual;
}

function filterMatches(
  filter: StepStage["filter"],
  ctx: StageContext,
): boolean {
  if (filter === undefined) return true;
  // For event-Steps the filter narrows by the firing site's
  // identity (stage name when called from the loop, agent name when
  // an `after-agent-result` fires under the result-delivery path).
  // Bundle-loader will pin the per-event resolution; the MVP
  // resolver below treats every filter as a stage-name match.
  // Bundle callers needing per-agent filters wire it as a function
  // form so the resolver stays predicate-based.
  // Stage-name access lives on the active StageContext via the
  // bundle's read.pipeline_state, but for the in-tx dispatch we
  // only have the StageContext itself; we approximate by passing
  // the StageContext to function filters and falling back to
  // string equality on the bundle name for string/RegExp forms.
  const probe = ctx.bundle.name;
  if (typeof filter === "string") return filter === probe;
  if (filter instanceof RegExp) return filter.test(probe);
  return filter(ctx);
}
