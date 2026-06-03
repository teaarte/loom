// Per-agent / per-phase provider routing.
//
// The router is the single point that turns an (agent, state[, phase])
// triple into a concrete LLMProvider (and optionally a model name).
// It accepts a structured config object (yaml parsing lives in a
// separate package so the kernel stays no-runtime-dep) plus the
// bundle and the provider list the bundle-loader assembled. Existing
// callers that omit `config` see the previous MVP shape — default
// provider falls through to providers[0] — so the registry stays
// backwards-compatible.
//
// Cascade (highest precedence first):
//   1. state.bundle_state.provider_override   (Step-pushed override)
//   2. config.model_overrides[`${agent}@${phase}`]  (model only — the
//                                                   matching provider
//                                                   still comes from a
//                                                   lower rung)
//   3. config.agent_routing[agent]            (provider + tier)
//   4. config.phase_routing[phase]            (provider + tier)
//   5. config.default_provider (+ config.default_model_tier),
//      falling back to bundle.default_provider
//   6. providers[0]                           (compat)
//
// Refusal codes:
//   PROVIDER_NOT_FOUND       — a routing rule names a provider that
//                              is not registered, or no rule produced
//                              a match and no fallback exists.
//   PROVIDER_TIER_UNKNOWN    — a route declares a tier the alias map
//                              does not declare.
//   PROVIDER_CONFIG_INVALID  — config object failed schema validation
//                              at construction time.

import { KernelError } from "./state/db.js";
import type { Bundle } from "./types/bundle.js";
import type { LLMProvider } from "./types/provider.js";
import type { ProviderRegistry, Registry } from "./types/registry.js";
import type { PipelineState } from "./types/state.js";

// ----- Config surface ------------------------------------------------------

export interface ProviderRoute {
  provider: string;
  tier: string;
}

export interface TierAlias {
  model: string;
}

export interface ModelOverride {
  model: string;
}

export interface ProvidersConfig {
  default_provider?: string;
  default_model_tier?: string;
  agent_routing?: Record<string, ProviderRoute>;
  phase_routing?: Record<string, ProviderRoute>;
  tier_aliases?: Record<string, TierAlias>;
  // Key form: `${agent}@${phase}`.
  model_overrides?: Record<string, ModelOverride>;
}

export interface ProviderOverride {
  agent: string;
  provider: string;
  model?: string;
}

export interface ProviderRouterOptions {
  providers: LLMProvider[];
  config: ProvidersConfig;
  bundle: Bundle;
}

// ----- Public entry --------------------------------------------------------

export function createProviderRouter(opts: ProviderRouterOptions): ProviderRegistry {
  const { providers, config, bundle } = opts;
  validateConfig(config);

  const byName = new Map<string, LLMProvider>();
  for (const p of providers) byName.set(p.name, p);

  function lookupProvider(name: string, source: string): LLMProvider {
    const picked = byName.get(name);
    if (picked === undefined) {
      throw new KernelError({
        code: "PROVIDER_NOT_FOUND",
        message: `route '${source}' names provider '${name}' which is not registered`,
        detail: { provider: name, source },
      });
    }
    return picked;
  }

  function resolveTierModel(tier: string, source: string): string {
    const alias = config.tier_aliases?.[tier];
    if (alias === undefined) {
      throw new KernelError({
        code: "PROVIDER_TIER_UNKNOWN",
        message: `route '${source}' references tier '${tier}' which is not declared in tier_aliases`,
        detail: { tier, source },
      });
    }
    return alias.model;
  }

  function readStageOverride(state: PipelineState, agent: string): ProviderOverride | null {
    const bs = state.bundle_state;
    if (bs === null || typeof bs !== "object") return null;
    const override = (bs as Record<string, unknown>)["provider_override"];
    if (override === null || typeof override !== "object") return null;
    const o = override as Record<string, unknown>;
    if (typeof o["agent"] !== "string" || o["agent"] !== agent) return null;
    if (typeof o["provider"] !== "string") return null;
    const r: ProviderOverride = { agent, provider: o["provider"] };
    if (typeof o["model"] === "string") r.model = o["model"];
    return r;
  }

  interface ResolvedRoute {
    provider: LLMProvider;
    model: string | null;
  }

  function resolveRoute(
    agent: string,
    state: PipelineState,
    phase: string | undefined,
  ): ResolvedRoute {
    // 1. Stage-time override
    const override = readStageOverride(state, agent);
    if (override !== null) {
      const provider = lookupProvider(override.provider, "bundle_state.provider_override");
      return { provider, model: override.model ?? null };
    }

    // Per-agent + per-phase / per-agent / per-phase route lookups
    const agentRoute = config.agent_routing?.[agent];
    const phaseRoute = phase !== undefined ? config.phase_routing?.[phase] : undefined;

    // 2. Model override at `${agent}@${phase}` — uses the agent (or
    //    phase) route to determine which provider to dispatch on, then
    //    swaps the model name.
    const overrideKey = phase !== undefined ? `${agent}@${phase}` : null;
    const modelOverride =
      overrideKey !== null ? config.model_overrides?.[overrideKey] : undefined;

    if (modelOverride !== undefined) {
      // Provider for the override falls through to the next rungs:
      // agent_routing → phase_routing → default_provider. The model
      // string comes from the override.
      const pickedProvider =
        agentRoute !== undefined
          ? lookupProvider(agentRoute.provider, `agent_routing[${agent}]`)
          : phaseRoute !== undefined
            ? lookupProvider(phaseRoute.provider, `phase_routing[${phase ?? ""}]`)
            : pickDefaultProvider(agent);
      return { provider: pickedProvider, model: modelOverride.model };
    }

    // 3. agent_routing
    if (agentRoute !== undefined) {
      const provider = lookupProvider(agentRoute.provider, `agent_routing[${agent}]`);
      const model = resolveTierModel(agentRoute.tier, `agent_routing[${agent}]`);
      return { provider, model };
    }

    // 4. phase_routing
    if (phaseRoute !== undefined) {
      const provider = lookupProvider(phaseRoute.provider, `phase_routing[${phase ?? ""}]`);
      const model = resolveTierModel(phaseRoute.tier, `phase_routing[${phase ?? ""}]`);
      return { provider, model };
    }

    // 5. default_provider + default_model_tier (config) → bundle default → providers[0]
    const provider = pickDefaultProvider(agent);
    const tier = config.default_model_tier;
    const model = tier !== undefined ? resolveTierModel(tier, "default_model_tier") : null;
    return { provider, model };
  }

  function pickDefaultProvider(agent: string): LLMProvider {
    if (config.default_provider !== undefined) {
      return lookupProvider(config.default_provider, "default_provider");
    }
    if (bundle.default_provider !== undefined) {
      const picked = byName.get(bundle.default_provider);
      if (picked !== undefined) return picked;
    }
    const fallback = providers[0];
    if (fallback !== undefined) return fallback;
    throw new KernelError({
      code: "PROVIDER_NOT_FOUND",
      message: `no provider configured for agent '${agent}'`,
      detail: { agent, providers_registered: 0 },
    });
  }

  function resolve(agent: string, state: PipelineState, phase?: string): LLMProvider {
    return resolveRoute(agent, state, phase).provider;
  }

  function resolveModel(
    agent: string,
    state: PipelineState,
    phase?: string,
  ): string | null {
    return resolveRoute(agent, state, phase).model;
  }

  return {
    all: providers,
    resolve,
    resolveModel,
    health_check_all: Promise.resolve(
      [] as { name: string; healthy: boolean; reason?: string }[],
    ),
  };
}

// Resolve the concrete model name to dispatch a spawn with — the single
// authority both spawn paths use (the driver's fresh-spawn intents and the
// kernel's re-shuttle directive), so the model is chosen identically whether a
// spawn runs the first time or is resumed.
//
// Precedence: the config route (`agent_routing` / `model_overrides` /
// `tier_aliases` — the UI-editable per-agent override) wins; otherwise the
// agent's bundle-declared tier (`agent.default_model`, e.g. "fast") maps
// through the bundle's `default_model_tiers`; an unknown or already-concrete
// value passes through unchanged. The backend executor stays dumb — it
// receives a ready model name and never interprets a tier.
export function resolveSpawnModel(
  registry: Registry,
  agent: string,
  phase: string | undefined,
  state: PipelineState,
): string {
  // Optional chaining across the three registry surfaces so the resolver is
  // safe to call from any spawn path (including a `begin_spawn` default) even
  // when a hand-built registry omits one of them — a full production registry
  // always carries all three, so this only hardens the edges.
  const routed = registry.providers?.resolveModel?.(agent, state, phase) ?? null;
  if (routed !== null && routed !== "") return routed;
  const tier = registry.agents?.get(agent)?.default_model ?? "default";
  return registry.bundle?.default_model_tiers?.[tier] ?? tier;
}

// ----- Config schema validation -------------------------------------------

function validateConfig(config: ProvidersConfig): void {
  if (typeof config !== "object" || config === null) {
    throw new KernelError({
      code: "PROVIDER_CONFIG_INVALID",
      message: "providers config must be an object",
      detail: { received: config === null ? "null" : typeof config },
    });
  }
  if (config.default_provider !== undefined && typeof config.default_provider !== "string") {
    refuseField("default_provider", "string");
  }
  if (
    config.default_model_tier !== undefined &&
    typeof config.default_model_tier !== "string"
  ) {
    refuseField("default_model_tier", "string");
  }
  validateRouteMap(config.agent_routing, "agent_routing");
  validateRouteMap(config.phase_routing, "phase_routing");
  validateTierAliases(config.tier_aliases);
  validateModelOverrides(config.model_overrides);
}

function refuseField(field: string, expected: string): never {
  throw new KernelError({
    code: "PROVIDER_CONFIG_INVALID",
    message: `providers config field '${field}' must be ${expected}`,
    detail: { field, expected },
  });
}

function validateRouteMap(
  map: Record<string, ProviderRoute> | undefined,
  field: string,
): void {
  if (map === undefined) return;
  if (typeof map !== "object" || map === null) {
    refuseField(field, "object");
  }
  for (const [key, value] of Object.entries(map)) {
    if (typeof value !== "object" || value === null) {
      throw new KernelError({
        code: "PROVIDER_CONFIG_INVALID",
        message: `providers config ${field}['${key}'] must be an object with provider+tier`,
        detail: { field, key },
      });
    }
    const v = value as unknown as Record<string, unknown>;
    if (typeof v["provider"] !== "string") {
      throw new KernelError({
        code: "PROVIDER_CONFIG_INVALID",
        message: `providers config ${field}['${key}'].provider must be a string`,
        detail: { field, key, missing: "provider" },
      });
    }
    if (typeof v["tier"] !== "string") {
      throw new KernelError({
        code: "PROVIDER_CONFIG_INVALID",
        message: `providers config ${field}['${key}'].tier must be a string`,
        detail: { field, key, missing: "tier" },
      });
    }
  }
}

function validateTierAliases(map: Record<string, TierAlias> | undefined): void {
  if (map === undefined) return;
  if (typeof map !== "object" || map === null) refuseField("tier_aliases", "object");
  for (const [key, value] of Object.entries(map)) {
    if (typeof value !== "object" || value === null || typeof (value as unknown as Record<string, unknown>)["model"] !== "string") {
      throw new KernelError({
        code: "PROVIDER_CONFIG_INVALID",
        message: `providers config tier_aliases['${key}'].model must be a string`,
        detail: { field: "tier_aliases", key },
      });
    }
  }
}

function validateModelOverrides(
  map: Record<string, ModelOverride> | undefined,
): void {
  if (map === undefined) return;
  if (typeof map !== "object" || map === null) refuseField("model_overrides", "object");
  for (const [key, value] of Object.entries(map)) {
    if (typeof value !== "object" || value === null || typeof (value as unknown as Record<string, unknown>)["model"] !== "string") {
      throw new KernelError({
        code: "PROVIDER_CONFIG_INVALID",
        message: `providers config model_overrides['${key}'].model must be a string`,
        detail: { field: "model_overrides", key },
      });
    }
  }
}
