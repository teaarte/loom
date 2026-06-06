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

  // Partial over GateRole: a bundle declares postures only for the roles
  // its flow actually gates. The three kernel-shipped role literals stay
  // for autocomplete but are NOT required keys — a bundle whose roles are
  // entirely its own (none of classify/plan/final) declares only those.
  // The dispatcher's three-tier `?? … ?? "human"` resolution tolerates any
  // missing role.
  default_gate_policies: Partial<Record<GateRole, PolicyName>>;
  // Required when any role resolves to PolicyName "auto" — loader
  // refuses bundles that mark a role auto without shipping a resolver.
  policyResolver?: GatePolicyResolver;
  policy_factories?: Record<PolicyName, () => Policy>;

  default_provider?: string;

  // Bundle-author defaults mapping each abstract model TIER an agent declares
  // (`agent.default_model`, e.g. "fast" / "balanced" / "premium") to a concrete
  // model name for the default backend — so a zero-config install resolves a
  // tier to a real model. A project's `.loom/providers.json` (the UI-editable
  // routing config) overrides per agent; an unknown/concrete value passes
  // through unchanged. The bundle stays backend-abstract by naming tiers; only
  // these defaults name concrete models.
  default_model_tiers?: Record<string, string>;

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

  // Optional complexity → flow routing. The task starts on `default_flow`;
  // once the FSM advances past `after_stage` the kernel re-selects the
  // active flow ONCE from `map`, keyed on `decisions[decision_key]`. All
  // flows named in `map`, plus `default_flow`, MUST share an identical
  // prefix up to and including `after_stage` so `step_index` stays aligned
  // across the switch — the loader refuses a map that breaks this
  // (COMPLEXITY_FLOW_PREFIX_MISMATCH). Writing `driver.flow_name` is
  // driver-internal; bundle code never touches it — the kernel performs
  // the switch from this declared map.
  complexity_flows?: ComplexityFlowMap;

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

  // Static context the renderer materializes off the bundle source tree
  // at load and appends to the spawn-context block. The kernel names no
  // domain concept here — the bundle supplies the heading and the source
  // shape; the renderer reads the files and formats them generically (it
  // never imports the bundle, same as template materialization).
  spawn_context_assets?: SpawnContextAsset[];
}

// Declarative complexity → flow routing. `decision_key` names the decision
// the choice keys on (e.g. "complexity"); `after_stage` is the flow stage
// after which the kernel switches the active flow once; `map` routes a
// decision value to a flow name. See `Bundle.complexity_flows`.
export interface ComplexityFlowMap {
  decision_key: string;
  after_stage: string;
  map: Record<string, string>;
}

// A bundle-declared block of static context surfaced under the heading
// the bundle chooses. `agents` scopes it to specific agents (omitted →
// every spawn): a large catalog belongs only in the prompt that consumes
// it, not in every sibling's prompt.
//
//   - "frontmatter-catalog" — for every `*.md` under `dir` (sorted), emit
//     its path + the verbatim frontmatter block. A digest the consumer
//     reads to pick by filename; the bodies stay out of the prompt.
//   - "file" — inline the file at `path` verbatim in a fenced block.
//
// Paths/dirs resolve relative to the bundle source root, like
// `Agent.template_path`.
export type SpawnContextAsset =
  | {
      heading: string;
      kind: "frontmatter-catalog";
      dir: string;
      agents?: string[];
    }
  | {
      heading: string;
      kind: "file";
      path: string;
      fence?: string;
      agents?: string[];
    };
