// `full-autonomous` — every role delegates to the bundle resolver.
// Only safe to apply when the bundle ships deterministic safety-floor
// invariants AND a `policyResolver`; the loader refuses bundles that
// declare this preset without both.

import type { PolicyName } from "../types/policy.js";
import type { GateRole } from "../types/row-types.js";

export const preset: Record<GateRole, PolicyName> = {
  classify: "auto",
  plan: "auto",
  final: "auto",
};
