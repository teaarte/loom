// `review-plan-only` — human reviewer at the plan gate; everything
// else delegates to the bundle resolver. Common operator workflow
// when the classifier + final gates are trusted but the plan benefits
// from a human sanity check before code lands.

import type { PolicyName } from "../types/policy.js";
import type { GateRole } from "../types/row-types.js";

export const preset: Record<GateRole, PolicyName> = {
  classify: "auto",
  plan: "human",
  final: "auto",
};
