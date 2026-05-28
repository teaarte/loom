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

// Kahn's algorithm over the `requires` DAG. Walks the input array
// each round so two hooks that become ready in the same step retain
// their registration order — the contract the loader relies on.
export function topoSortHooks(hooks: Hook[]): Hook[] {
  const indegree = new Map<string, number>();
  const byName = new Map<string, Hook>();
  const dependents = new Map<string, string[]>();

  for (const h of hooks) {
    if (byName.has(h.name)) {
      throw new KernelError({
        code: "HOOK_NAME_DUPLICATE",
        message: `duplicate hook name '${h.name}'`,
        detail: { hook: h.name },
      });
    }
    byName.set(h.name, h);
    indegree.set(h.name, 0);
  }

  for (const h of hooks) {
    for (const req of h.requires ?? []) {
      if (!byName.has(req)) {
        throw new KernelError({
          code: "HOOK_REQUIRES_UNKNOWN",
          message: `hook '${h.name}' requires unknown hook '${req}'`,
          detail: { hook: h.name, missing: req },
        });
      }
      indegree.set(h.name, (indegree.get(h.name) ?? 0) + 1);
      const list = dependents.get(req) ?? [];
      list.push(h.name);
      dependents.set(req, list);
    }
  }

  const sorted: Hook[] = [];
  const placed = new Set<string>();
  // Repeated input-order scans keep tie-break stable; with the
  // registry cap (~100 hooks) the O(N²) bound is negligible against
  // the SQLite tx cost that surrounds every fire.
  while (sorted.length < hooks.length) {
    let progressed = false;
    for (const h of hooks) {
      if (placed.has(h.name)) continue;
      if ((indegree.get(h.name) ?? 0) !== 0) continue;
      sorted.push(h);
      placed.add(h.name);
      for (const depName of dependents.get(h.name) ?? []) {
        indegree.set(depName, (indegree.get(depName) ?? 0) - 1);
      }
      progressed = true;
    }
    if (!progressed) break;
  }

  if (sorted.length !== hooks.length) {
    const residual = hooks.filter((h) => !placed.has(h.name)).map((h) => h.name);
    throw new KernelError({
      code: "HOOK_CYCLE",
      message: `hook dependency cycle: ${residual.join(", ")}`,
      detail: { cycle: residual },
    });
  }

  return sorted;
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
