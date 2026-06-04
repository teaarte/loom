// A CLIENT-side mirror of the server's `(backend, model)` compatibility gate, so
// the model-map editor can warn BEFORE a `PUT /config` the server would reject.
// The server stays the authority (it re-runs the same check on write); this is a
// pre-flight hint only.
//
// It is driven entirely by DATA the server hands back: the configured backend
// mode and the `/providers` roster (each backend → the provider families it can
// run). It hardcodes no backend, family, agent, tier, or bundle name — feed it a
// fabricated roster and it stays correct. Pure (no DOM) so it is node-testable.

import type { ProviderInfo } from "./types.js";

export type ValidatePairResult = { ok: true } | { ok: false; message: string };

// The provider FAMILY a model ref names: the text before the first `:` when both
// sides are non-empty (`anthropic:claude-sonnet` → `anthropic`). A bare value
// (`premium`, a tier) has no family and resolves within the chosen backend.
export function parseFamily(ref: string): string | undefined {
  const idx = ref.indexOf(":");
  if (idx <= 0 || idx >= ref.length - 1) return undefined;
  return ref.slice(0, idx);
}

// Validate a model ref against the configured backend, using the providers
// roster. Rules mirror the server gate:
//   - backend `auto` → accepted (auto picks a compatible backend at dispatch);
//   - a bare ref (no family) → accepted (family unknown here);
//   - an unknown backend → rejected (typo guard);
//   - a backend whose families exclude the ref's family → rejected, suggesting
//     the backends that CAN run it.
export function validateModelRef(
  backendMode: string,
  providers: readonly ProviderInfo[],
  ref: string,
): ValidatePairResult {
  if (backendMode === "auto") return { ok: true };

  const family = parseFamily(ref);
  if (family === undefined) return { ok: true };

  const entry = providers.find((p) => p.backend === backendMode);
  if (entry === undefined) {
    const known = providers.map((p) => p.backend).join(", ");
    return { ok: false, message: `unknown backend '${backendMode}'${known.length > 0 ? ` — known: ${known}` : ""}` };
  }

  if (entry.families.includes(family)) return { ok: true };

  const alternatives = providers.filter((p) => p.families.includes(family)).map((p) => p.backend);
  const suggestion = alternatives.length > 0 ? ` — use ${alternatives.join(" or ")}` : "";
  return {
    ok: false,
    message: `backend '${backendMode}' can't run a ${family} model (it serves ${entry.families.join(", ")})${suggestion}`,
  };
}
