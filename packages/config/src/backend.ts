// Per-spawn backend resolution — turn (configured backend mode, a model's
// provider family, Claude-Code availability) into the ONE backend that runs a
// spawn. This is the dispatch counterpart of the static `(backend, model)`
// validation: validation rejects an impossible pairing at entry; this picks the
// concrete backend at run time.
//
// `auto` is CC-first, mirroring the container toggle's "prefer X if available,
// else fall back with a LOUD notice": an anthropic-family spawn runs on Claude
// Code when its CLI is present (best harness, on the subscription, no API key),
// and falls back to the raw `anthropic-sdk` backend (an API key) with a notice
// when it is not. Every other family routes to its raw backend. An explicit
// pin is VALIDATED against the capability table and never overridden. An
// incompatible or unserviceable request returns a clean error — never a silent
// mis-run.
//
// Selection is by GENERIC signal only — the provider family of the agent's
// model + availability — never by an agent's name or domain meaning.

import { AUTO_BACKEND, validateBackendFamily } from "./capabilities.js";

// The CC backend: the only one whose availability is a runtime probe (the CLI
// on PATH). The raw API backends are structurally "available" here — their
// credential is checked where the executor is built, not here — so this leaf
// stays pure (no spawning, no file probes).
const CLAUDE_CODE_BACKEND = "claude-code";

// `auto` preference order per provider family: the first AVAILABLE backend wins.
// Anthropic is CC-first with a raw fallback; the single-vendor families route to
// their raw backend. Families whose only backends are CLI adapters (a later
// generation — codex / gemini / aider) are intentionally ABSENT, so `auto`
// returns a clean "no backend yet" error for them rather than guessing. Grow a
// row here when a backend's executor is wired.
const AUTO_PREFERENCE: Readonly<Record<string, readonly string[]>> = {
  anthropic: [CLAUDE_CODE_BACKEND, "anthropic-sdk"],
  openrouter: ["openrouter"],
  ollama: ["ollama"],
};

// A model with NO provider family (a bare tier or concrete name) carries no
// routing signal, so `auto` defaults to CC-first only — there is no family to
// pick a raw backend from.
const AUTO_NO_FAMILY: readonly string[] = [CLAUDE_CODE_BACKEND];

export interface ResolveBackendInput {
  // The configured backend mode: `auto` (default) or a pinned backend name.
  configBackend: string;
  // The provider family of the agent's resolved model (`provider:` prefix), or
  // undefined for a bare tier / concrete model.
  family?: string;
  // Whether the Claude Code CLI is available (a PATH probe the caller ran).
  ccAvailable: boolean;
}

export type ResolveBackendResult =
  | { ok: true; backend: string; notice?: string }
  | { ok: false; error: string };

function isAvailable(backend: string, ccAvailable: boolean): boolean {
  // Only Claude Code has a runtime-probed availability; raw backends defer their
  // credential check to executor build.
  if (backend === CLAUDE_CODE_BACKEND) return ccAvailable;
  return true;
}

// Resolve the backend for one spawn. `auto` consults the preference order and
// falls back loudly; a pin is validated and used. Returns a clean error for an
// incompatible pin, an unserviceable family, or a pinned-but-unavailable
// Claude Code.
export function resolveBackend(input: ResolveBackendInput): ResolveBackendResult {
  const { configBackend, family, ccAvailable } = input;

  // ----- explicit pin: validate, never override --------------------------
  if (configBackend !== AUTO_BACKEND) {
    const compat = validateBackendFamily(configBackend, family);
    if (!compat.ok) return { ok: false, error: compat.message };
    if (!isAvailable(configBackend, ccAvailable)) {
      return {
        ok: false,
        error:
          `backend '${configBackend}' is pinned but the Claude Code CLI was not found; ` +
          `install Claude Code and sign in, or pin a different backend`,
      };
    }
    return { ok: true, backend: configBackend };
  }

  // ----- auto: CC-first preference order ---------------------------------
  const order = family === undefined ? AUTO_NO_FAMILY : AUTO_PREFERENCE[family];
  if (order === undefined || order.length === 0) {
    const hint =
      family === undefined
        ? ""
        : ` for provider family '${family}'`;
    return {
      ok: false,
      error:
        `no backend is available${hint} yet — pin a 'provider:model' or configure a backend ` +
        `(a CLI adapter for it is a later step)`,
    };
  }

  const first = order[0];
  if (first !== undefined && isAvailable(first, ccAvailable)) {
    return { ok: true, backend: first };
  }

  // The preferred backend is unavailable — fall back through the order with a
  // loud notice (the only B fallback is Claude-Code → anthropic-sdk).
  for (let i = 1; i < order.length; i++) {
    const cand = order[i];
    if (cand !== undefined && isAvailable(cand, ccAvailable)) {
      return {
        ok: true,
        backend: cand,
        notice:
          `'${first}' is unavailable (the Claude Code CLI was not found or you are not signed in); ` +
          `falling back to '${cand}'${family !== undefined ? ` for ${family} models` : ""} — ` +
          `it needs its own API credential. Install + sign in to Claude Code to run on your ` +
          `subscription, or pin a backend to silence this.`,
      };
    }
  }

  return {
    ok: false,
    error:
      family === undefined
        ? `no usable backend: the Claude Code CLI was not found and no 'provider:model' is configured — ` +
          `install Claude Code and sign in, or set a provider model ` +
          `(e.g. 'loom models set <agent> openrouter:<model>') or pin a backend`
        : `no available backend for provider family '${family}' (tried ${order.join(", ")})`,
  };
}
