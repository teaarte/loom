// Rule 12 — MANIFEST_CAPABILITY_MISSING.
//
// The runtime Bundle shape and the manifest snapshot the prior
// reconciliation pass committed must agree on observable behaviors.
// Event-position StepStages, Hooks, Invariants, and a shipped
// `migrations/` directory each demand their own manifest capability;
// the loader refuses any mismatch so an operator-visible runtime
// behavior cannot ship as undeclared.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { KernelError } from "@loomfsm/kernel";
import type { Bundle } from "@loomfsm/kernel";
import type { ExtensionManifest } from "@loomfsm/kernel";

export function validateManifestCrossCheck(
  bundle: Bundle,
  manifest: ExtensionManifest,
  bundle_source_dir: string | undefined,
): void {
  const caps = new Set<string>(manifest.capabilities);

  // Event-position StepStage → stage.event
  for (const [key, stage] of Object.entries(bundle.stages)) {
    if (stage.kind !== "step") continue;
    if (stage.position !== "event") continue;
    if (!caps.has("stage.event")) {
      throw new KernelError({
        code: "MANIFEST_CAPABILITY_MISSING",
        message: `bundle declares event-position step '${key}' but manifest omits capability 'stage.event'`,
        detail: { capability: "stage.event", source: { stage: key } },
      });
    }
  }

  // Hooks → hook.side_effect
  if (bundle.hooks.length > 0 && !caps.has("hook.side_effect")) {
    const example = bundle.hooks[0];
    throw new KernelError({
      code: "MANIFEST_CAPABILITY_MISSING",
      message: `bundle registers hooks but manifest omits capability 'hook.side_effect'`,
      detail: {
        capability: "hook.side_effect",
        source: { hook: example?.name },
      },
    });
  }

  // Invariants → invariant.bundle
  if (bundle.invariants.length > 0 && !caps.has("invariant.bundle")) {
    const example = bundle.invariants[0];
    throw new KernelError({
      code: "MANIFEST_CAPABILITY_MISSING",
      message: `bundle registers invariants but manifest omits capability 'invariant.bundle'`,
      detail: {
        capability: "invariant.bundle",
        source: { invariant: (example as { name?: string } | undefined)?.name ?? null },
      },
    });
  }

  // migrations/ directory → migration.bundle (only when source dir given)
  if (bundle_source_dir !== undefined) {
    const migrationsDir = join(bundle_source_dir, "migrations");
    if (existsSync(migrationsDir) && statSync(migrationsDir).isDirectory()) {
      if (!caps.has("migration.bundle")) {
        throw new KernelError({
          code: "MANIFEST_CAPABILITY_MISSING",
          message: `bundle ships a migrations/ directory but manifest omits capability 'migration.bundle'`,
          detail: {
            capability: "migration.bundle",
            source: { path: migrationsDir },
          },
        });
      }
    }
  }
}
