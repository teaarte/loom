// `full-supervised` — every kernel-recognized role goes through a
// human reviewer. The conservative ceiling; useful when starting a new
// bundle whose auto-policy resolver has not been audited yet.

import type { PolicyName } from "../types/policy.js";
import type { GateRole } from "../types/row-types.js";

export const preset: Record<GateRole, PolicyName> = {
  classify: "human",
  plan: "human",
  final: "human",
};
