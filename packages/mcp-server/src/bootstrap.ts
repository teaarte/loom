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

import codeBundle, { codeManifest } from "@loomfsm/bundle-code";
import {
  captureNow,
  loadBundle,
  openDb,
  reconcileExtensions,
  type LLMProvider,
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
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const building = buildRegistry(projectDir, providers).catch((err: unknown) => {
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

async function buildRegistry(
  projectDir: string,
  providers: LLMProvider[],
): Promise<Registry> {
  const now = captureNow();

  // Open the project DB so kernel migrations apply before the loader
  // reads the installed-extensions table.
  openDb(projectDir);

  // Idempotent: an unchanged manifest row is left as-is.
  await reconcileExtensions({
    manifests: [{ path: BUNDLE_MANIFEST_SOURCE, raw: codeManifest }],
    project_dir: projectDir,
    now,
  });

  return await loadBundle({
    bundle: codeBundle,
    bundle_source_dir: bundleSourceDir,
    project_dir: projectDir,
    providers,
    providers_config: readProvidersConfig(projectDir),
    now,
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

// Test seam: drop the default resolver's per-project cache so a suite can
// rebuild a registry for a reused project path. Resolvers built via
// `createAssembleRegistry` own their own caches (fresh per construction).
export function _resetRegistryCacheForTest(): void {
  defaultResolverCache.clear();
}
