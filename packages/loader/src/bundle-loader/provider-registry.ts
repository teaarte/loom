// Thin Registry-assembler wrapper. Routing intelligence (per-agent /
// per-phase / tier / stage-time override) lives in
// `../provider-router.ts`. When a caller omits the `config` object
// the router falls through to its default-provider + providers[0]
// cascade — the same shape the prior monolithic MVP exposed, so
// callers that do not supply a `ProvidersConfig` see identical
// behavior.

import { createProviderRouter } from "../provider-router.js";
import type { ProvidersConfig } from "../provider-router.js";
import type { Bundle } from "@loomfsm/kernel";
import type { LLMProvider } from "@loomfsm/kernel";
import type { ProviderRegistry } from "@loomfsm/kernel";

export function buildProviderRegistry(
  providers: LLMProvider[],
  bundle: Bundle,
  config?: ProvidersConfig,
): ProviderRegistry {
  return createProviderRouter({
    providers,
    bundle,
    config: config ?? {},
  });
}
