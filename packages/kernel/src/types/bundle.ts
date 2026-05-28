// Bundle — the unit of domain knowledge. Names phases, agents, stages,
// flows, hooks, invariants, and policy resolvers. The kernel does not
// know what "code review" or "research" is; the bundle names the world.

import type { AttemptBudget } from "./budget.js";
import type { GatePolicyResolver, Policy, PolicyName } from "./policy.js";
import type { GateRole, Phase } from "./row-types.js";
import type { Invariant } from "./invariants.js";
import type { Agent, Hook, Stage } from "./plugins.js";

export interface Bundle {
  name: string;
  version: string;
  description: string;
  phases: Phase[];
  default_flow: string;

  default_gate_policies: Record<GateRole, PolicyName>;
  // Required when any role resolves to PolicyName "auto" — loader
  // refuses bundles that mark a role auto without shipping a resolver.
  policyResolver?: GatePolicyResolver;
  policy_factories?: Record<PolicyName, () => Policy>;

  default_provider?: string;

  agents: Agent[];
  stages: Record<string, Stage>;
  flows: Record<string, string[]>;
  hooks: Hook[];
  invariants: Invariant[];

  // Map gate-stage names → GateRole. Required so the GateStage
  // interpreter can resolve a role for every gate in the flow; bundles
  // with no gate stages may ship `{}` rather than omitting the field.
  gate_roles: Record<string, GateRole>;
  declared_change_kinds?: string[];

  extends_vocab?: {
    error_classes?: string[];
    output_kinds?: string[];
    audit_types?: string[];
    gate_roles_extra?: GateRole[];
  };

  replan_budget?: AttemptBudget;

  schema_extension?: string;
  knowledge_dir?: string;
  prompts_dir?: string;
  migrations_dir?: string;
}
