// Rule 7 — GATE_ROLE_UNKNOWN.
//
// Each `GateStage` must map to a role in `bundle.gate_roles`; the role
// must be either kernel-baseline (`classify` / `plan` / `final`) or
// declared in `bundle.extends_vocab.gate_roles_extra`.

import { KernelError } from "../../state/db.js";
import type { Bundle } from "../../types/bundle.js";

const KERNEL_GATE_ROLES: ReadonlySet<string> = new Set(["classify", "plan", "final"]);

export function validateGateRoles(bundle: Bundle): void {
  const extraRoles = new Set<string>(bundle.extends_vocab?.gate_roles_extra ?? []);
  for (const [key, stage] of Object.entries(bundle.stages)) {
    if (stage.kind !== "gate") continue;
    const role = bundle.gate_roles[key];
    if (role === undefined) {
      throw new KernelError({
        code: "GATE_ROLE_UNKNOWN",
        message: `gate stage '${key}' has no entry in bundle.gate_roles`,
        detail: { gate: key },
      });
    }
    if (!KERNEL_GATE_ROLES.has(role) && !extraRoles.has(role)) {
      throw new KernelError({
        code: "GATE_ROLE_UNKNOWN",
        message: `gate '${key}' uses role '${role}' which is neither a kernel role nor declared in extends_vocab.gate_roles_extra`,
        detail: { gate: key, role },
      });
    }
  }
}
