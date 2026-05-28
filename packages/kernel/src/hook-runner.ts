// Post-commit subscriber dispatch.
//
// `HookRunner.fire(event, ctx)` iterates registered `Hook`s, matches
// each one's `event` + `filter` against the incoming event + context,
// and invokes the hook's `run`. Hooks ALWAYS fire after the kernel
// transaction has committed — they never see a `tx`, and a hook
// failure audits as `error_class:"hook-failure"` without rolling back
// state that is already on disk. In-transaction event work belongs in
// an event-position `StepStage` instead and goes through
// `dispatchEventSteps`; the two surfaces are disjoint by construction.
//
// Idempotency: this revision is the simple-loop variant — every fire
// runs every matching hook. The ledger-aware variant that records
// per-hook `side-effect-hook:<name>:<corr>` markers and skips already-
// completed runs supersedes it via `setLedger(ledger)` when the
// side-effect-hook ledger writer ships; existing call sites stay
// unchanged.

import type { HookContext } from "./types/context.js";
import type { Hook, HookEvent } from "./types/plugins.js";
import type { Registry } from "./types/registry.js";

// Forward-declared ledger surface. The simple loop ignores it;
// `setLedger` plugs in a concrete implementation later.
export interface HookLedger {
  hookAlreadyRan(name: string, correlation: string): Promise<boolean>;
  markHookOk(name: string, correlation: string): Promise<void>;
  markHookFailed(name: string, correlation: string, err: unknown): Promise<void>;
}

export class HookRunner {
  private ledger: HookLedger | null = null;

  constructor(private readonly registry: Registry) {}

  setLedger(ledger: HookLedger): void {
    this.ledger = ledger;
  }

  // Fire every Hook whose declared event + filter match. Failures are
  // swallowed at the Runner boundary (recorded for audit but the FSM
  // proceeds) — the post-commit world is best-effort by design.
  async fire(event: HookEvent, ctx: HookContext): Promise<void> {
    const hooks = this.registry.hooks;
    if (hooks.length === 0) return;
    for (const hook of hooks) {
      if (!eventMatches(hook.event, event)) continue;
      if (!filterMatches(hook.filter, ctx)) continue;
      if (this.ledger !== null) {
        const seen = await this.ledger.hookAlreadyRan(
          hook.name,
          ctx.idem_correlation,
        );
        if (seen) continue;
      }
      try {
        await hook.run(ctx);
        if (this.ledger !== null) {
          await this.ledger.markHookOk(hook.name, ctx.idem_correlation);
        }
      } catch (err) {
        if (this.ledger !== null) {
          await this.ledger.markHookFailed(
            hook.name,
            ctx.idem_correlation,
            err,
          );
        }
        // Audit emission for failures lives on the call site that
        // owns the active tx; this runner is post-commit and has no
        // tx of its own.
      }
    }
  }
}

export function eventMatches(
  declared: HookEvent | RegExp,
  actual: HookEvent,
): boolean {
  if (declared instanceof RegExp) return declared.test(actual);
  return declared === actual;
}

export function filterMatches(
  filter:
    | string
    | RegExp
    | ((ctx: HookContext) => boolean)
    | undefined,
  ctx: HookContext,
): boolean {
  if (filter === undefined) return true;
  const subject = ctx.stage ?? ctx.agent ?? "";
  if (typeof filter === "string") return filter === subject;
  if (filter instanceof RegExp) return filter.test(subject);
  return filter(ctx);
}
