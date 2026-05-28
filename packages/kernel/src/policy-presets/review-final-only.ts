// `review-final-only` — human at the final gate, automated upstream.
// Mirrors the "let the bots iterate, ask me before merging" workflow.

import type { PolicyName } from "../types/policy.js";
import type { GateRole } from "../types/row-types.js";

export const preset: Record<GateRole, PolicyName> = {
  classify: "auto",
  plan: "auto",
  final: "human",
};
