// @loomfsm/loader — build-time registry assembly.
//
// Everything here runs ONCE at start-up, off the replay hot path: discover
// and reconcile installed extensions, validate a bundle's declarative shape
// through the cascade, and assemble the `Registry` the kernel ticks. The
// kernel depends on none of it — these symbols used to ride on the
// `@loomfsm/kernel` barrel; splitting them out keeps the substrate's auditable
// surface to the tick-time runtime.

export { loadBundle } from "./bundle-loader/index.js";
export type { LoadBundleOptions } from "./bundle-loader/index.js";
export {
  discoverExtensions,
  reconcileExtensions,
} from "./extension-loader.js";
export type {
  DiscoveredManifest,
  ExtensionId,
  ReconciliationReport,
} from "./extension-loader.js";
export { createProviderRouter } from "./provider-router.js";
export type {
  ProvidersConfig,
  ProviderRoute,
  ProviderRouterOptions,
  ProviderOverride,
  TierAlias,
  ModelOverride,
} from "./provider-router.js";
