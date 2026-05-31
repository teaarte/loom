// ExtensionManifest + PromptTemplate.
//
// Every installed extension (Bundle, Provider, MCPClient) declares an
// `ExtensionManifest`; UI editors round-trip prompts as `PromptTemplate`.
// The bundle-loader validates manifests at startup — fail loud, not at
// first spawn.

import type { AgentOutputKind } from "./plugins.js";
import type { ModelName } from "./row-types.js";

export type ExtensionKind = "bundle" | "provider" | "mcp-client";

export interface ExtensionManifest {
  manifest_version: "1.0";
  name: string;
  display_name: string;
  description: string;
  version: string;
  kind: ExtensionKind;
  publisher: string;
  capabilities: ExtensionCapability[];
  requires: {
    kernel_api: string;
    extensions?: { name: string; version: string }[];
  };
  signature?: {
    algo: "ed25519";
    public_key_fingerprint: string;
    signature: string;
  };
}

// Open string set — kernel-additive enum. Insert-time validation goes
// through the vocabulary primitive.
export type ExtensionCapability = string;

export interface PromptTemplate {
  schema_version: "1.0";
  name: string;
  description: string;
  output_kind: AgentOutputKind;
  default_model: ModelName;
  // Safe expression DSL (JSON-Logic-shaped). When set, the
  // bundle-loader normalizes this to the same internal predicate type
  // as `Agent.applies_to: (state) => boolean`. TS-authored bundles may
  // use either form; UI editors use this serializable form exclusively.
  applies_to_expr?: Record<string, unknown>;
  relevant_for_change_kinds?: string[];
  mcp_tools?: string[];
  context_budget?: ContextBudget;
  // Optional parent template. Resolution is a path relative to the
  // bundle root. Scalars: child wins if set. `mcp_tools`: union.
  // `variables`: union by `path` key. Body: literal placeholder
  // `{{> super.body}}` inlines the parent; otherwise child fully
  // overrides. Cycles refused at registry-load time.
  extends?: string;
  body: string;
  variables: VariableBinding[];
}

export interface ContextBudget {
  soft_threshold_tokens?: number;
  hard_threshold_tokens?: number;
}

export interface VariableBinding {
  path: string;
  source:
    | "state"
    | "decisions"
    | "phases"
    | "findings"
    | "agent_records"
    | "context";
  schema?: Record<string, unknown>;
  default?: string;
}

// A template after the bundle-loader has read it off disk and stripped
// an optional frontmatter block. Stored in `Registry.prompts` keyed by
// agent name; the tick-time renderer reads `body` and substitutes
// context variables into it.
//
// `system_prompt` / `context_budget` carry whatever the frontmatter
// declared so the load-time read is the single filesystem touch. The
// renderer never inlines `system_prompt` into the rendered body — the
// spawn intent carries it as a separate, provider-cacheable prefix, so
// inlining would double it.
export interface RenderedTemplate {
  agent: string;
  body: string;
  system_prompt?: string;
  context_budget?: ContextBudget;
}

// A bundle `SpawnContextAsset` after the load-time read: `body` is the
// final formatted text (catalog digest or fenced file), ready to append
// verbatim under `## <heading>` in the spawn-context block. `agents`
// scopes which spawns receive it (undefined → all). Pre-rendering at load
// keeps the tick-time builder pure and free of further IO.
export interface RenderedContextAsset {
  heading: string;
  body: string;
  agents?: string[];
}
