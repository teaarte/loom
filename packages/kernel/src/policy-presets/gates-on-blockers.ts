// `gates-on-blockers` — the substrate default. Every role uses the
// `on-blockers` factory: human if the role's phase has any open
// blocking findings, otherwise delegate to the bundle resolver (or
// auto-approve when no resolver is registered).
//
// Honest baseline: gates pass when reviewers agree the code is clean,
// and ask for a human whenever a blocking finding is open.

import type { PolicyName } from "../types/policy.js";
import type { GateRole } from "../types/row-types.js";

export const preset: Record<GateRole, PolicyName> = {
  classify: "on-blockers",
  plan: "on-blockers",
  final: "on-blockers",
};
