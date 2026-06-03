// Production registry assembly — the wiring the active-task tools need
// to tick a real flow.
//
// `assembleRegistry(projectDir)` is the resolver the stdio entrypoint
// injects as `ServerDeps.resolveRegistry`. It does the three things a
// project needs before its first FSM tick:
//
//   1. Resolve the bundle's source root (where `agents/` and the prompt
//      templates live) so the loader can read every agent's `.md` body
//      off disk into the prompt map.
//   2. Open the project DB (kernel migrations apply on first open) and
//      idempotently reconcile the bundle's manifest into the project's
//      installed-extensions table — the loader refuses a bundle whose
//      manifest row is absent, and a re-run with an unchanged manifest
//      is a no-op (no duplicate rows, no spurious change event).
//   3. Load the bundle with the zero-config shuttle provider and return
//      the assembled Registry.
//
// The Registry is cached per project for the process lifetime: the FSM
// reads a fresh state snapshot every tick, but the registry itself is a
// static product of (bundle source + installed manifest) that does not
// change between ticks, so building it once is safe. A rejected build is
// evicted so a transient failure (e.g. a not-yet-built bundle dist) does
// not poison every later call.
//
// This lives in the transport package for now; a shared runtime home is
// the natural next move once a second entrypoint wants the same wiring.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import codeBundle, { codeManifest, CODE_BUNDLE_AGENT_EXECUTION, type AgentExecution } from "@loomfsm/bundle-code";
import {
  resolveBundleModels,
  resolveConfig,
  type BundleRoster,
  type ResolvedModel,
} from "@loomfsm/config";
import {
  captureNow,
  loadBundle,
  openDb,
  reconcileExtensions,
  type LLMProvider,
  type ProviderRoute,
  type ProvidersConfig,
  type Registry,
} from "@loomfsm/kernel";
import { claudeCodeShuttleProvider } from "@loomfsm/provider-claude-code-shuttle";

// Resolve the bundle package root through Node's own resolver so it works
// both from an installed `node_modules/@loomfsm/bundle-code` and from a
// workspace symlink in the monorepo. `package.json` is always resolvable
// regardless of any `exports` map; its directory is the source root the
// loader resolves each agent's `template_path` against.
const bundleSourceDir = dirname(
  createRequire(import.meta.url).resolve("@loomfsm/bundle-code/package.json"),
);

// Synthetic source tag for the reconciled manifest. The reconcile core
// treats this as an opaque label (it only surfaces in a fallback id when
// validation fails, which cannot happen for the curated bundle manifest).
const BUNDLE_MANIFEST_SOURCE = "@loomfsm/bundle-code:manifest";

// Build a per-project registry resolver over a fixed provider set. The
// provider SET is a deployment choice the entrypoint owns — the generic
// server bundles only the zero-config shuttle default; a deployment that
// wants other backends (a local model, a hosted API) injects them here
// rather than the server hardcoding every provider package. Per-agent /
// per-phase routing among the registered set is then a project-level
// `.claude/providers.json` (read at build).
//
// Concurrent first calls share one in-flight build via the cached promise;
// a rejected build is evicted so a transient failure does not poison later
// calls.
export function createAssembleRegistry(
  providers: LLMProvider[],
): (projectDir: string) => Promise<Registry> {
  return makeResolver(providers, new Map<string, Promise<Registry>>());
}

function makeResolver(
  providers: LLMProvider[],
  cache: Map<string, Promise<Registry>>,
): (projectDir: string) => Promise<Registry> {
  return function assemble(projectDir: string): Promise<Registry> {
    const key = resolve(projectDir);

    // Re-reconcile the manifest on EVERY call, before returning the registry
    // (cached or freshly built). The task store is single-task: finishing a
    // task rotates the whole store into history and frees the slot, which
    // also drops the project's installed-extensions rows. Without a
    // re-reconcile the next task would open a fresh, bundle-less store and
    // refuse with "no enabled bundle". The reconcile is idempotent and
    // cheap (it runs once per tool call, not per FSM tick), so restoring the
    // manifest each time is safe; the expensive registry object — the loaded
    // bundle with every agent template read off disk — is still built once
    // per process and cached.
    const ensured = ensureProjectReconciled(projectDir);

    const cached = cache.get(key);
    if (cached !== undefined) return ensured.then(() => cached);

    const building = ensured
      .then(() => buildRegistry(projectDir, providers))
      .catch((err: unknown) => {
        cache.delete(key);
        throw err;
      });
    cache.set(key, building);
    return building;
  };
}

// The default resolver's cache is module-level so the test seam can clear
// it; resolvers from `createAssembleRegistry` own private caches.
const defaultResolverCache = new Map<string, Promise<Registry>>();
const defaultResolver = makeResolver([claudeCodeShuttleProvider], defaultResolverCache);

// The production resolver the stdio entrypoint injects: zero-config shuttle
// only. Per-agent provider routing still works for any provider in this
// set; to route to other backends, an entrypoint builds its own resolver
// via `createAssembleRegistry([...])`.
export function assembleRegistry(projectDir: string): Promise<Registry> {
  return defaultResolver(projectDir);
}

// Per-agent EXECUTION shape (single-shot vs agentic) for a loaded bundle, keyed
// by bundle NAME. Surfaced HERE — where the bundle package is already imported —
// so the generic CLI never imports a bundle to learn which agents need a tool
// harness; it reads this through `resolveBundleName()` it already has. A bundle
// declares the map as a package sidecar (zero kernel); an unlisted bundle yields
// the empty map, so every agent defaults to single-shot. Single-bundle today;
// this generalizes to a lookup when a bundle registry lands.
const AGENT_EXECUTION_BY_BUNDLE: Readonly<Record<string, Readonly<Record<string, AgentExecution>>>> = {
  [codeBundle.name]: CODE_BUNDLE_AGENT_EXECUTION,
};

export function agentExecutionFor(bundleName: string): Readonly<Record<string, AgentExecution>> {
  return AGENT_EXECUTION_BY_BUNDLE[bundleName] ?? {};
}

// Ensure the project store exists (migrations apply on first open) and
// carries the bundle manifest row. Idempotent: an unchanged manifest is
// left as-is. Run on every resolver call so a store that was rotated away
// since the last build is restored before the loader / the next task reads
// the installed-extensions table.
async function ensureProjectReconciled(projectDir: string): Promise<void> {
  openDb(projectDir);
  await reconcileExtensions({
    manifests: [{ path: BUNDLE_MANIFEST_SOURCE, raw: codeManifest }],
    project_dir: projectDir,
    now: captureNow(),
  });
}

async function buildRegistry(
  projectDir: string,
  providers: LLMProvider[],
): Promise<Registry> {
  // The manifest is already reconciled by `ensureProjectReconciled` before
  // this runs; the loader reads the installed-extensions row it left.
  return await loadBundle({
    bundle: codeBundle,
    bundle_source_dir: bundleSourceDir,
    project_dir: projectDir,
    providers,
    providers_config: composeProvidersConfig(projectDir, codeBundle, providers),
    now: captureNow(),
  });
}

// Optional per-project provider routing, read from `.claude/providers.json`
// (the same `.claude/` dir the state DB lives in). Absent → no routing
// (every agent resolves to the default provider). Present-but-malformed is
// surfaced as an error rather than silently ignored; the kernel router
// validates the parsed shape and refuses unknown providers/tiers.
function readProvidersConfig(projectDir: string): ProvidersConfig | undefined {
  const path = join(projectDir, ".claude", "providers.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined; // absent → no routing config
  }
  try {
    return JSON.parse(raw) as ProvidersConfig;
  } catch (err) {
    throw new Error(`invalid provider routing config at ${path}: ${(err as Error).message}`);
  }
}

// Compose the routing config the loader consumes from the layered control plane
// PLUS the legacy per-project `providers.json`, preserving the project-rung
// precedence: the global model map is the floor, the legacy `providers.json` sits
// above it, and the project `loom.json` model map wins on top —
//
//   built-in ← bundle defaults ← global ← [ providers.json ← loom.json ]
//
// The control layer (`@loomfsm/config`) hands back a GENERIC per-agent model map;
// this kernel-aware seam (where `providers.json` is already read) is the one place
// that turns it into a `ProvidersConfig`, feeding the existing `resolveSpawnModel`
// path with ZERO kernel change. A 0.2.1 project with only `providers.json` and no
// control-layer files composes to exactly its `providers.json` — nothing regresses.
function composeProvidersConfig(
  projectDir: string,
  bundle: typeof codeBundle,
  providers: LLMProvider[],
): ProvidersConfig | undefined {
  const defaultProvider = bundle.default_provider ?? providers[0]?.name;
  const resolved = resolveConfig({ projectDir, env: process.env });
  const roster: BundleRoster = {
    name: bundle.name,
    agents: bundle.agents,
    ...(bundle.default_model_tiers !== undefined
      ? { default_model_tiers: bundle.default_model_tiers }
      : {}),
    ...(bundle.default_provider !== undefined ? { default_provider: bundle.default_provider } : {}),
  };

  const pcGlobal =
    defaultProvider !== undefined
      ? providersConfigFromModelMap(resolveBundleModels(resolved.layers.global, roster), defaultProvider)
      : {};
  const pcLegacy = readProvidersConfig(projectDir) ?? {};
  const pcProject =
    defaultProvider !== undefined
      ? providersConfigFromModelMap(resolveBundleModels(resolved.layers.project, roster), defaultProvider)
      : {};

  const composed = mergeProvidersConfig(mergeProvidersConfig(pcGlobal, pcLegacy), pcProject);
  return isEmptyProvidersConfig(composed) ? undefined : composed;
}

// Turn a generic per-agent model map into routing. Each configured agent gets an
// `agent_routing` entry on the default backend pointing at a per-agent synthetic
// tier alias carrying the resolved model — so the kernel's `resolveModel` returns
// that model verbatim. The synthetic tier name is unique per agent, so layers
// merge without colliding with real bundle tiers. (The provider FAMILY a
// `provider:model` ref carries is for per-backend dispatch later; today only the
// single default backend runs, so only the model name is consumed here.)
export function providersConfigFromModelMap(
  resolved: Record<string, ResolvedModel>,
  defaultProvider: string,
): ProvidersConfig {
  const agent_routing: Record<string, ProviderRoute> = {};
  const tier_aliases: Record<string, { model: string }> = {};
  for (const [agent, m] of Object.entries(resolved)) {
    const tier = `__loom:${agent}`;
    agent_routing[agent] = { provider: defaultProvider, tier };
    tier_aliases[tier] = { model: m.model };
  }
  const out: ProvidersConfig = {};
  if (Object.keys(agent_routing).length > 0) {
    out.agent_routing = agent_routing;
    out.tier_aliases = tier_aliases;
  }
  return out;
}

// Merge two routing configs, the second winning per key. Map-valued fields union
// (a higher layer overrides a lower layer's entry for the SAME agent / tier /
// phase / key); scalars take the higher value when present.
export function mergeProvidersConfig(lower: ProvidersConfig, higher: ProvidersConfig): ProvidersConfig {
  const out: ProvidersConfig = {};
  const dp = higher.default_provider ?? lower.default_provider;
  if (dp !== undefined) out.default_provider = dp;
  const dmt = higher.default_model_tier ?? lower.default_model_tier;
  if (dmt !== undefined) out.default_model_tier = dmt;

  const agentRouting = { ...lower.agent_routing, ...higher.agent_routing };
  if (Object.keys(agentRouting).length > 0) out.agent_routing = agentRouting;
  const phaseRouting = { ...lower.phase_routing, ...higher.phase_routing };
  if (Object.keys(phaseRouting).length > 0) out.phase_routing = phaseRouting;
  const tierAliases = { ...lower.tier_aliases, ...higher.tier_aliases };
  if (Object.keys(tierAliases).length > 0) out.tier_aliases = tierAliases;
  const modelOverrides = { ...lower.model_overrides, ...higher.model_overrides };
  if (Object.keys(modelOverrides).length > 0) out.model_overrides = modelOverrides;

  return out;
}

function isEmptyProvidersConfig(pc: ProvidersConfig): boolean {
  return Object.keys(pc).length === 0;
}

// Test seam: drop the default resolver's per-project cache so a suite can
// rebuild a registry for a reused project path. Resolvers built via
// `createAssembleRegistry` own their own caches (fresh per construction).
export function _resetRegistryCacheForTest(): void {
  defaultResolverCache.clear();
}

// The roster of the bundle this server runs — agent names, tiers, and the tier
// defaults — as plain data, with no DB open or registry build. The control-layer
// verbs (`loom models …`) read it to bind agents to models by name; it is the
// single source of the roster so nothing hardcodes an agent or tier name.
export function activeBundleRoster(): BundleRoster {
  return {
    name: codeBundle.name,
    agents: codeBundle.agents,
    ...(codeBundle.default_model_tiers !== undefined
      ? { default_model_tiers: codeBundle.default_model_tiers }
      : {}),
    ...(codeBundle.default_provider !== undefined
      ? { default_provider: codeBundle.default_provider }
      : {}),
  };
}
