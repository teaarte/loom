// Rule 10 — AUTO_POLICY_INCOMPLETE.
//
// A `default_gate_policies[role] === "auto"` declaration commits the
// bundle to two coupled obligations: a `policyResolver` factory that
// can mint the auto policy at runtime, and a name-matching safety-floor
// invariant (`INV_safety_floor_<role>`) that bounds what the auto
// policy can accept. Either missing → the loader refuses; partial
// auto-acceptance with no floor is the silent-corruption case the
// safety-floor design exists to prevent.

import { KernelError } from "../../state/db.js";
import type { Bundle } from "../../types/bundle.js";

export function validateAutoPolicy(bundle: Bundle): void {
  for (const role of Object.keys(bundle.default_gate_policies)) {
    if (bundle.default_gate_policies[role] !== "auto") continue;

    const missing: string[] = [];
    if (bundle.policyResolver === undefined) missing.push("policyResolver");

    const expectedName = `INV_safety_floor_${role}`;
    const hasSafetyFloor = bundle.invariants.some(
      (inv) => (inv as { name?: unknown }).name === expectedName,
    );
    if (!hasSafetyFloor) missing.push("safety_floor_invariant");

    if (missing.length > 0) {
      throw new KernelError({
        code: "AUTO_POLICY_INCOMPLETE",
        message: `role '${role}' resolves to 'auto' but the bundle is missing: ${missing.join(", ")}`,
        detail: { role, missing, expected_invariant: expectedName },
      });
    }
  }
}
