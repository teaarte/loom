// Backend ↔ model compatibility — the static table that makes "run a Gemini
// model through Codex" / "Claude through Gemini" structurally impossible,
// caught at entry rather than mis-run.
//
// A model is written `provider:model` (`anthropic:claude-sonnet`,
// `openrouter:deepseek`, `google:gemini-2.x`). The `provider:` prefix is the
// FAMILY. Each backend declares which families it serves. These are
// backend/provider INFRA names — cross-bundle, not a bundle's domain — so a
// static map here does not break genericity (which is about bundle / agent /
// tier blindness).
//
// This module only STORES the backend mode and VALIDATES a pair at
// `loom models set` time; the per-spawn dispatch and the `auto` preference order
// are not wired here — they land with per-backend execution later.

export const AUTO_BACKEND = "auto";

// backend name → the provider families it can run.
export const BACKEND_CAPABILITIES: Readonly<Record<string, readonly string[]>> = {
  "claude-code": ["anthropic"],
  "anthropic-sdk": ["anthropic"],
  codex: ["openai"],
  gemini: ["google"],
  openrouter: ["openrouter"],
  ollama: ["ollama"],
  // Model-agnostic multiplexer — one adapter fronts several families.
  aider: ["anthropic", "openai", "google", "openrouter", "ollama"],
};

export function knownBackends(): string[] {
  return [AUTO_BACKEND, ...Object.keys(BACKEND_CAPABILITIES)];
}

export interface ParsedModelRef {
  // The provider family (before the first `:`), or undefined for a bare value
  // (a tier or a concrete model name with no family).
  family?: string;
  // The model portion (after the first `:`), or the whole value when bare.
  model: string;
}

// Split `provider:model` into its family + model. A value with no `:` is a bare
// tier / concrete model: no family, model = the whole string.
export function parseModelRef(ref: string): ParsedModelRef {
  const idx = ref.indexOf(":");
  if (idx < 0) return { model: ref };
  const family = ref.slice(0, idx);
  const model = ref.slice(idx + 1);
  if (family.length === 0 || model.length === 0) return { model: ref };
  return { family, model };
}

export type ValidatePairResult = { ok: true } | { ok: false; message: string };

// Validate a `(backend, family)` pairing against the capability table — the one
// source of pair compatibility, shared by `validatePair` (entry, at
// `loom models set`) and `resolveBackend` (dispatch). Rules:
//   - backend `auto` → ACCEPTED (auto picks a compatible backend at dispatch);
//   - `family === undefined` (a bare tier / concrete model) → ACCEPTED (the
//     family is unknown here; it resolves within the chosen backend);
//   - an unknown backend name → REJECTED (typo guard);
//   - a known backend whose families EXCLUDE the family → REJECTED with a
//     helpful suggestion of backends that CAN run it.
export function validateBackendFamily(
  backend: string,
  family: string | undefined,
): ValidatePairResult {
  if (backend === AUTO_BACKEND) return { ok: true };

  const families = BACKEND_CAPABILITIES[backend];
  if (families === undefined) {
    return {
      ok: false,
      message: `unknown backend '${backend}' — known backends: ${knownBackends().join(", ")}`,
    };
  }

  if (family === undefined) return { ok: true };

  if (!families.includes(family)) {
    const alternatives = Object.entries(BACKEND_CAPABILITIES)
      .filter(([, fams]) => fams.includes(family))
      .map(([name]) => name);
    const suggestion =
      alternatives.length > 0
        ? ` — use ${alternatives.join(" or ")}`
        : "";
    return {
      ok: false,
      message: `backend '${backend}' can't run a ${family} model (it serves ${families.join(", ")})${suggestion}`,
    };
  }
  return { ok: true };
}

// Validate a `(backend, modelRef)` pair: parse the ref's `provider:` family and
// defer to `validateBackendFamily`. A bare ref (no family) is accepted.
export function validatePair(backend: string, modelRef: string): ValidatePairResult {
  return validateBackendFamily(backend, parseModelRef(modelRef).family);
}
