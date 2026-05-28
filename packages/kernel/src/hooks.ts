// Hook resolution primitives — pure functions on the registered hook
// set. `HookRunner` (see `./hook-runner.ts`) calls these once at
// construction so a registry-load cycle surfaces synchronously and
// per-fire dispatch is a Map lookup plus a linear scan of RegExp
// subscribers.
//
// Topological order is the SINGLE ordering mechanism — there is no
// parallel priority channel. Tie-break is input-array order so the
// resolved sequence is stable across runs.

import { KernelError } from "./state/db.js";
import { topoSortHooks as topoSortHooksUnion } from "./hook-topo.js";
import type { HookContext } from "./types/context.js";
import type { Hook, HookEvent } from "./types/plugins.js";

// Per-event lookup view. Exact-string events serve from `byEvent`
// (O(1) map hit); RegExp-event hooks live in `regExpHooks` and are
// tested against the firing event name on every dispatch (regex
// matching cannot be pre-indexed).
export interface HookIndex {
  byEvent: Map<HookEvent, Hook[]>;
  regExpHooks: Hook[];
}

// Throws on cycle to match the local-caller (`HookRunner` constructor)
// contract: a cyclic registry is a load-time bug surfaced synchronously.
// The lower-level `hook-topo` helper returns the cycle as a tagged
// union so the bundle-loader can fold the failure into its own refusal
// cascade alongside other validation rules without catching a throw
// mid-walk.
export function topoSortHooks(hooks: Hook[]): Hook[] {
  const result = topoSortHooksUnion(hooks);
  if ("cycle" in result) {
    throw new KernelError({
      code: "HOOK_CYCLE",
      message: `hook dependency cycle: ${result.cycle.join(", ")}`,
      detail: { cycle: result.cycle },
    });
  }
  return result.sorted;
}

export function indexHooksByEvent(sorted: Hook[]): HookIndex {
  const byEvent = new Map<HookEvent, Hook[]>();
  const regExpHooks: Hook[] = [];
  for (const h of sorted) {
    if (h.event instanceof RegExp) {
      regExpHooks.push(h);
      continue;
    }
    const list = byEvent.get(h.event) ?? [];
    list.push(h);
    byEvent.set(h.event, list);
  }
  return { byEvent, regExpHooks };
}

export function resolveHooks(event: HookEvent, index: HookIndex): Hook[] {
  const out: Hook[] = [];
  const exact = index.byEvent.get(event);
  if (exact !== undefined) {
    for (const h of exact) out.push(h);
  }
  for (const h of index.regExpHooks) {
    if (h.event instanceof RegExp && h.event.test(event)) out.push(h);
  }
  return out;
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
  // `stage` for stage-keyed events; `agent` for agent-result events;
  // empty string when neither is set so a string filter against an
  // unset subject simply fails to match.
  const subject = ctx.stage ?? ctx.agent ?? "";
  if (typeof filter === "string") return filter === subject;
  if (filter instanceof RegExp) return filter.test(subject);
  return filter(ctx);
}
