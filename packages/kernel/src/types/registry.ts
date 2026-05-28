// Registry — the kernel's hot lookup table after bundle load.
//
// `agents` / `stages` are keyed by name; `hooks` is topo-sorted by
// `requires` (Kahn's algorithm, tie-break = registration order).

import type { Bundle } from "./bundle.js";
import type { Invariant } from "./invariants.js";
import type { Agent, Hook, MCPClientPlugin, Stage } from "./plugins.js";
import type { Policy, PolicyName } from "./policy.js";
import type { LLMProvider } from "./provider.js";
import type { PipelineState } from "./state.js";
import type { KernelVocabularies } from "./vocabulary.js";

export interface Registry {
  bundle: Bundle;
  agents: Map<string, Agent>;
  stages: Map<string, Stage>;
  flows: Map<string, string[]>;
  hooks: Hook[];
  invariants: Invariant[];
  mcp_clients: Map<string, MCPClientPlugin>;
  providers: ProviderRegistry;
  // Materialized merge of kernel-default vocabulary baselines with the
  // bundle's `extends_vocab` declarations. Insert-time `.has()`
  // predicates against the open audit/output-kind/error-class columns
  // read from here; the loader is the single point that constructs the
  // sets.
  vocabularies: KernelVocabularies;
  // Materialized at registry-load from the kernel-shipped stock
  // factories (`human`, `on-blockers`, `auto`) plus any
  // bundle-registered ones. The gate interpreter resolves a name via
  // `state.gate_policies[role] ?? "human"` then calls the factory to
  // get a Policy instance — keeping the state row pure-data while
  // the call site stays a one-liner.
  policyFactories: Map<PolicyName, () => Policy>;
}

export interface ProviderRegistry {
  // `phase` is optional so callers that do not have phase context
  // (e.g. the spawn-resolver in `ctx.resolve_provider(agent)`)
  // continue to compile. The router consults phase_routing only
  // when the caller supplies the third argument.
  resolve(agent: string, state: PipelineState, phase?: string): LLMProvider;
  // Sibling lookup the spawn caller may use to obtain the routed
  // model name without duplicating the cascade. Optional on the
  // interface — registry stubs in tests and the legacy MVP shape
  // do not implement it; the production router that ships from
  // `createProviderRouter` always does.
  resolveModel?(agent: string, state: PipelineState, phase?: string): string | null;
  all: LLMProvider[];
  health_check_all: Promise<{ name: string; healthy: boolean; reason?: string }[]>;
}
