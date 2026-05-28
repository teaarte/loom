// Hook topo-sort — Kahn's algorithm over the `requires` DAG.
//
// Two failure modes throw directly because they signal a structural
// authoring bug the caller cannot recover from: a duplicate hook name
// would silently overwrite earlier registrations, and a `requires`
// pointing at an unregistered name has no remediation path inside the
// sort. The cycle case, by contrast, surfaces as a tagged return so a
// loader caller can fold it into a higher-level refusal alongside its
// other cascade rules instead of catching a thrown error mid-cascade.
//
// Tie-break is input-array order — the registered hook list passes
// through the topology stably so a deterministic registration order
// produces a deterministic dispatch order on every run.

import { KernelError } from "./state/db.js";
import type { Hook } from "./types/plugins.js";

export type TopoSortResult =
  | { sorted: Hook[] }
  | { cycle: string[] };

export function topoSortHooks(hooks: Hook[]): TopoSortResult {
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
    const cycle = hooks.filter((h) => !placed.has(h.name)).map((h) => h.name);
    return { cycle };
  }

  return { sorted };
}
