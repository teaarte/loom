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

export interface Registry {
  bundle: Bundle;
  agents: Map<string, Agent>;
  stages: Map<string, Stage>;
  flows: Map<string, string[]>;
  hooks: Hook[];
  invariants: Invariant[];
  mcp_clients: Map<string, MCPClientPlugin>;
  providers: ProviderRegistry;
  // Materialized at registry-load from the kernel-shipped stock
  // factories (`human`, `on-blockers`, `auto`) plus any
  // bundle-registered ones. The gate interpreter resolves a name via
  // `state.gate_policies[role] ?? "human"` then calls the factory to
  // get a Policy instance — keeping the state row pure-data while
  // the call site stays a one-liner.
  policyFactories: Map<PolicyName, () => Policy>;
}

export interface ProviderRegistry {
  resolve(agent: string, state: PipelineState): LLMProvider;
  all: LLMProvider[];
  health_check_all: Promise<{ name: string; healthy: boolean; reason?: string }[]>;
}
