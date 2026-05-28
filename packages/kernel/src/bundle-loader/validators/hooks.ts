// Rule 9 — HOOK_CYCLE.
//
// The kernel relies on `Hook.requires[]` forming a DAG so the runtime
// HookRunner can fire hooks in deterministic, dependency-respecting
// order. A cycle would deadlock the runner; the loader refuses early
// so operators see the bad declaration at start, not at first fire.

import { topoSortHooks } from "../../hook-topo.js";
import { KernelError } from "../../state/db.js";
import type { Bundle } from "../../types/bundle.js";
import type { Hook } from "../../types/plugins.js";

export function validateHookGraph(bundle: Bundle): Hook[] {
  const result = topoSortHooks(bundle.hooks);
  if ("cycle" in result) {
    throw new KernelError({
      code: "HOOK_CYCLE",
      message: `hook dependency cycle: ${result.cycle.join(", ")}`,
      detail: { cycle: result.cycle },
    });
  }
  return result.sorted;
}
