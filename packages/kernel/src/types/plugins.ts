// Forward-declared plugin contracts.
//
// The full Agent / Stage / Hook / MCPClientPlugin / SandboxPlugin
// shapes ship alongside the plugin-contracts work. They are forward-
// declared here so the kernel type surface compiles standalone;
// downstream packages refine these via declaration merging or replace
// the placeholders with their canonical definitions.
//
// `LLMProvider` is the one plugin contract that lives in `provider.ts`
// instead of here — it pulls in `ProviderResult` / `ProviderSpawnRequest`
// directly, so co-locating with those keeps imports flat.

import type { BundleStateView } from "./state.js";
import type { TimeBudget } from "./budget.js";
import type { HookContext, StageContext } from "./context.js";

export interface PluginMeta {
  name: string;
}

// Agent output classification. Kernel-default set listed below;
// bundles extend via `Bundle.extends_vocab.output_kinds` per the
// kernel-additive enum convention. Runtime validation refuses values
// outside `KernelVocabularies.output_kinds.all`.
export type AgentOutputKind =
  | "reviewer"
  | "validator"
  | "nonreview"
  | "classifier"
  | (string & {});

export interface Agent extends PluginMeta {
  template_path: string;
  output_kind: AgentOutputKind;
  default_model?: string;
  applies_to?: (state: BundleStateView) => boolean;
  relevant_for_change_kinds?: string[];
  mcp_tools?: string[];
}

export interface Stage extends PluginMeta {
  applies_to?: (state: BundleStateView) => boolean;
  run(ctx: StageContext): Promise<void>;
}

export interface Hook extends PluginMeta {
  event: string;
  requires?: string[];
  run(ctx: HookContext): Promise<void>;
}

export interface MCPClientPlugin extends PluginMeta {
  endpoint: string;
  scope: "task" | "global";
  call_budget?: TimeBudget;
  tool_idempotency?: Record<string, boolean>;
}

export interface SandboxPlugin extends PluginMeta {
  kind: string;
  exec(
    command: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exit_code: number }>;
}

export type Sandbox = SandboxPlugin;
