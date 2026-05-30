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

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import codeBundle, { codeManifest } from "@loom/bundle-code";
import {
  captureNow,
  loadBundle,
  openDb,
  reconcileExtensions,
  type Registry,
} from "@loom/kernel";
import { claudeCodeShuttleProvider } from "@loom/provider-claude-code-shuttle";

// Resolve the bundle package root through Node's own resolver so it works
// both from an installed `node_modules/@loom/bundle-code` and from a
// workspace symlink in the monorepo. `package.json` is always resolvable
// regardless of any `exports` map; its directory is the source root the
// loader resolves each agent's `template_path` against.
const bundleSourceDir = dirname(
  createRequire(import.meta.url).resolve("@loom/bundle-code/package.json"),
);

// Synthetic source tag for the reconciled manifest. The reconcile core
// treats this as an opaque label (it only surfaces in a fallback id when
// validation fails, which cannot happen for the curated bundle manifest).
const BUNDLE_MANIFEST_SOURCE = "@loom/bundle-code:manifest";

const registryByProject = new Map<string, Promise<Registry>>();

// Resolve (building + caching on first touch) the FSM registry for a
// project. Concurrent first calls share one in-flight build via the
// cached promise.
export function assembleRegistry(projectDir: string): Promise<Registry> {
  const key = resolve(projectDir);
  const cached = registryByProject.get(key);
  if (cached !== undefined) return cached;

  const building = buildRegistry(projectDir).catch((err: unknown) => {
    // Evict the rejected build so the next call retries from scratch.
    registryByProject.delete(key);
    throw err;
  });
  registryByProject.set(key, building);
  return building;
}

async function buildRegistry(projectDir: string): Promise<Registry> {
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
    providers: [claudeCodeShuttleProvider],
    now,
  });
}

// Test seam: drop the per-project cache so a suite can rebuild a registry
// for a reused project path. Not part of the production call surface.
export function _resetRegistryCacheForTest(): void {
  registryByProject.clear();
}
