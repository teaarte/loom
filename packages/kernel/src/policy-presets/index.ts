// Named-preset registry. Each preset is a `.ts` module exporting
// `preset: Record<GateRole, PolicyName>`; the `Map<string, ...>` here
// indexes them by name. A new preset is a new file + one entry; the
// kernel doesn't ship a YAML parser (zero-runtime-deps rule), so the
// preset shape lives in TypeScript and is loaded at module-init.

import { KernelError } from "../state/db.js";
import type { PolicyName } from "../types/policy.js";
import type { GateRole } from "../types/row-types.js";

import { preset as fullSupervised } from "./full-supervised.js";
import { preset as reviewPlanOnly } from "./review-plan-only.js";
import { preset as reviewFinalOnly } from "./review-final-only.js";
import { preset as gatesOnBlockers } from "./gates-on-blockers.js";
import { preset as fullAutonomous } from "./full-autonomous.js";

export type PresetMap = Record<GateRole, PolicyName>;

export const KERNEL_POLICY_PRESETS: ReadonlyMap<string, PresetMap> = new Map<
  string,
  PresetMap
>([
  ["full-supervised", fullSupervised],
  ["review-plan-only", reviewPlanOnly],
  ["review-final-only", reviewFinalOnly],
  ["gates-on-blockers", gatesOnBlockers],
  ["full-autonomous", fullAutonomous],
]);

// Caller-facing accessor. Throws `POLICY_PRESET_UNKNOWN` when the
// name is not one of the kernel-shipped five — bundle / operator YAML
// presets are out of scope for this layer.
export function resolvePreset(name: string): PresetMap {
  const found = KERNEL_POLICY_PRESETS.get(name);
  if (found === undefined) {
    throw new KernelError({
      code: "POLICY_PRESET_UNKNOWN",
      message: `Preset '${name}' is not registered`,
      detail: {
        preset: name,
        known: [...KERNEL_POLICY_PRESETS.keys()],
      },
    });
  }
  return found;
}
