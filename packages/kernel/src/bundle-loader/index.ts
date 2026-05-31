// Bundle-loader cascade orchestrator.
//
// Reads the installed manifest, runs every declarative-shape validator
// in fixed first-failure-wins order, builds the merged vocabulary set,
// cross-checks the runtime structure against the manifest snapshot the
// reconciliation pass committed, then assembles the `Registry` the
// kernel hot-path consults.
//
// Why a cross-check at load time: a bundle reaching for the kernel
// `Transaction` directly bypasses the `BundleScratchTx` façade and the
// invariant-rollback boundary that goes with it; an event-position
// `StepStage` without a manifest declaration is silent indirection; a
// Hook with side-effects but no manifest capability is an undeclared
// behavior. Each refusal here gives the operator a concrete remediation
// at kernel start — never at first fire.
//
// Cascade order is chosen so the operator's debugging path moves from
// the substrate-installed truth (manifest row exists) outward through
// the bundle's declarative shape (stage / agent / phase / role)
// toward the deeper graph properties (hook DAG, auto-policy safety
// floor, manifest cross-check, source-import discipline).

import { buildPolicyFactoryRegistry } from "../policies/index.js";
import { materializeContextAssets, materializeTemplates } from "../prompt-renderer.js";
import type { ProvidersConfig } from "../provider-router.js";
import { buildVocabularies } from "../vocabularies.js";
import type { Bundle } from "../types/bundle.js";
import type { RenderedContextAsset, RenderedTemplate } from "../types/extension.js";
import type { NowToken } from "../types/now.js";
import type {
  Agent,
  Hook,
  MCPClientPlugin,
  Stage,
} from "../types/plugins.js";
import type { LLMProvider } from "../types/provider.js";
import type { Registry } from "../types/registry.js";

import { readInstalledManifest } from "./installed-manifest.js";
import { buildProviderRegistry } from "./provider-registry.js";
import { validateAutoPolicy } from "./validators/auto-policy.js";
import { validateComplexityFlows } from "./validators/complexity-flows.js";
import { validateGateRoles } from "./validators/gate-roles.js";
import { validateHookGraph } from "./validators/hooks.js";
import { validateImportScope } from "./validators/import-scope.js";
import { validateManifestCrossCheck } from "./validators/manifest-cross-check.js";
import { validateStages } from "./validators/stages.js";

export interface LoadBundleOptions {
  bundle: Bundle;
  // Absolute path to the bundle package's source root. When omitted the
  // import-scope sweep and the migrations-directory probe are skipped —
  // production wiring always passes it; tests targeting other refusal
  // rules may leave it undefined.
  bundle_source_dir?: string;
  project_dir: string;
  providers: LLMProvider[];
  // Optional per-agent / per-phase provider + model routing. Omitted →
  // every agent resolves to the bundle default (or providers[0]). The
  // config's shape is validated at load (PROVIDER_CONFIG_INVALID); a route
  // naming an unregistered provider / undeclared tier is refused when that
  // agent resolves (PROVIDER_NOT_FOUND / PROVIDER_TIER_UNKNOWN).
  providers_config?: ProvidersConfig;
  mcp_clients?: MCPClientPlugin[];
  now: NowToken;
}

export async function loadBundle(opts: LoadBundleOptions): Promise<Registry> {
  const { bundle, bundle_source_dir, project_dir, providers, providers_config, mcp_clients } =
    opts;

  // 1. BUNDLE_NOT_INSTALLED
  const manifest = readInstalledManifest(project_dir, bundle.name);

  // 2..6 + 8 — declarative-shape validation against the Stage union.
  validateStages(bundle);

  // 6b — complexity → flow map: shared-prefix invariant (after validateStages
  //      confirms the flows + default_flow exist). Refuses a map whose flows
  //      would misalign step_index at the switch boundary.
  validateComplexityFlows(bundle);

  // 7 — gate-role lookup against bundle + extends_vocab.
  validateGateRoles(bundle);

  // 9 — hook DAG.
  const sortedHooks: Hook[] = validateHookGraph(bundle);

  // 10 — auto-policy demands a resolver AND a name-matching safety-
  //      floor invariant per role.
  validateAutoPolicy(bundle);

  // 11 — vocabulary build refuses sunset contradictions.
  const vocabularies = buildVocabularies(bundle);

  // 12 — manifest-vs-runtime capability cross-check.
  validateManifestCrossCheck(bundle, manifest, bundle_source_dir);

  // 13 — bundle source must not import the raw kernel Transaction.
  if (bundle_source_dir !== undefined) {
    validateImportScope(bundle_source_dir);
  }

  // 14 — materialize agent prompt templates off disk. The renderer
  //      reads files only here; the tick-time builder stays pure. A
  //      missing template is a load-time refusal (TEMPLATE_NOT_FOUND).
  //      Skipped when bundle_source_dir is absent (mirrors the
  //      import-scope sweep) — callers without it get an empty map and
  //      the renderer falls back to a deterministic stub.
  const prompts: Map<string, RenderedTemplate> =
    bundle_source_dir !== undefined
      ? materializeTemplates(bundle, bundle_source_dir)
      : new Map<string, RenderedTemplate>();

  // 14b — materialize the bundle's declared spawn-context assets off the
  //       same source tree (whatever the bundle pointed at — the kernel
  //       names none of them). Same source-dir gating as templates; a
  //       missing asset is a load-time refusal (CONTEXT_ASSET_NOT_FOUND).
  const context_assets: RenderedContextAsset[] =
    bundle_source_dir !== undefined
      ? materializeContextAssets(bundle, bundle_source_dir)
      : [];

  // Registry assembly — only reached when every cascade rule passed.
  const policyFactories = buildPolicyFactoryRegistry(bundle);
  const providerRegistry = buildProviderRegistry(providers, bundle, providers_config);

  const agents = new Map<string, Agent>();
  for (const a of bundle.agents) agents.set(a.name, a);

  const stages = new Map<string, Stage>();
  for (const [key, stage] of Object.entries(bundle.stages)) stages.set(key, stage);

  const flows = new Map<string, string[]>();
  for (const [name, steps] of Object.entries(bundle.flows)) flows.set(name, steps);

  const mcpMap = new Map<string, MCPClientPlugin>();
  for (const c of mcp_clients ?? []) mcpMap.set(c.name, c);

  const registry: Registry = {
    bundle,
    agents,
    stages,
    flows,
    hooks: sortedHooks,
    invariants: bundle.invariants,
    mcp_clients: mcpMap,
    providers: providerRegistry,
    policyFactories,
    vocabularies,
    prompts,
    context_assets,
  };
  return registry;
}
