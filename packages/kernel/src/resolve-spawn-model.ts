// Tick-time spawn-model resolution — the replay-critical half of the old
// provider-router module. The build-time router that ASSEMBLES a
// ProviderRegistry from a config object lives in the loader; this function
// only READS an already-assembled registry, and both spawn paths (the
// driver's fresh-spawn intents and the kernel's re-shuttle directive) call
// it, so it must stay in the substrate.

import type { Registry } from "./types/registry.js";
import type { PipelineState } from "./types/state.js";

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
