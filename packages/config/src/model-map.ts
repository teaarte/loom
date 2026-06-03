// The model-map view a caller turns into routing for the active bundle. This
// leaf produces a GENERIC result — `{ model, family? }` per agent — and never
// touches the kernel's `ProvidersConfig`; the kernel-aware caller (where the
// legacy `providers.json` is read at registry build) adapts this into routing.
//
// Genericity: the bundle name, agent names, and tier names are all data passed
// in. Nothing here is keyed to a particular bundle. A second (non-code) bundle's
// roster resolves through the exact same code path with zero change.

import { parseModelRef } from "./capabilities.js";
import type { BundleRoster, LoomConfig, ModelRef } from "./types.js";

// The agent → model-ref bindings for one bundle, from the (already-merged)
// config. Empty when the bundle has no entry.
export function bundleAgentMap(config: LoomConfig, bundleName: string): Record<string, ModelRef> {
  return config.bundles?.[bundleName]?.agents ?? {};
}

export interface ResolvedModel {
  // The concrete model name to dispatch (after tier expansion).
  model: string;
  // The provider family from a `provider:model` ref, if any (used for backend
  // compatibility / future dispatch); undefined for a bare tier or model.
  family?: string;
}

// Resolve one model ref to the concrete model + family:
//   - `provider:model` → { family, model };
//   - a bare value that names a tier in `defaultModelTiers` → that tier's model;
//   - any other bare value (a concrete model, or a tier the bundle did not map)
//     → passed through unchanged.
export function resolveModelRef(
  ref: ModelRef,
  defaultModelTiers?: Record<string, string>,
): ResolvedModel {
  const parsed = parseModelRef(ref);
  if (parsed.family !== undefined) return { family: parsed.family, model: parsed.model };
  const tierModel = defaultModelTiers?.[ref];
  if (tierModel !== undefined && tierModel.length > 0) return { model: tierModel };
  return { model: ref };
}

// Resolve every configured agent for a bundle to its concrete model + family,
// using the roster's tier map. Agents the config does not mention are omitted —
// they keep their bundle-declared default. The result is the generic input the
// caller's routing adapter consumes.
export function resolveBundleModels(
  config: LoomConfig,
  roster: BundleRoster,
): Record<string, ResolvedModel> {
  const map = bundleAgentMap(config, roster.name);
  const out: Record<string, ResolvedModel> = {};
  for (const [agent, ref] of Object.entries(map)) {
    out[agent] = resolveModelRef(ref, roster.default_model_tiers);
  }
  return out;
}
