// Backend credential resolution — turn a backend name into the concrete
// `{ apiKey?, baseUrl? }` its executor authenticates with, by a documented
// CONVENTION with an optional per-backend override.
//
// The convention: each API backend reads its key from a conventionally-named
// secret (resolved from secrets.json, then the environment), so a user runs
// `loom secrets set OPENROUTER_API_KEY …` once and every project inherits it —
// the same "configure once" posture as the model map. The `claude-code` backend
// has NO entry here: it runs on the Claude Code login (OAuth), resolved by its
// own executor, not as an API key. The value is resolved ONLY at the point the
// executor is built and is NEVER logged, stored back, or returned masked here
// (display paths use `maskSecret` instead).
//
// These are backend/provider INFRA names + their conventional env var names
// (cross-bundle), not any bundle's domain — so naming them here does not break
// genericity (which is about bundle / agent / tier blindness).

import { resolveMaybeRef, resolveSecret } from "./secrets.js";
import type { BackendCredentialConfig } from "./types.js";

// backend name → its conventional credential env var (the secret NAME looked up)
// and/or a base-URL env var. A backend absent here resolves no API key (e.g.
// `claude-code` uses OAuth via its own executor).
export const BACKEND_CREDENTIAL: Readonly<
  Record<string, { env?: string; baseUrlEnv?: string }>
> = {
  "anthropic-sdk": { env: "ANTHROPIC_API_KEY" },
  openrouter: { env: "OPENROUTER_API_KEY" },
  // Documented for the openai raw backend (its provider package is a later
  // step); the convention is fixed now so it is stable when that backend lands.
  openai: { env: "OPENAI_API_KEY" },
  // Local backend: no API key, an optional base URL (the host).
  ollama: { baseUrlEnv: "OLLAMA_HOST" },
};

export interface ResolvedCredential {
  apiKey?: string;
  baseUrl?: string;
}

export interface ResolveCredentialOptions {
  loomHome: string;
  env: NodeJS.ProcessEnv;
  // Per-backend override (config.credentials[backend]); when present its refs win
  // over the convention.
  override?: BackendCredentialConfig;
}

// Resolve a backend's credential: the override's refs first (a `secret:<name>`
// ref or a literal), else the conventional secret / base-URL env. An
// unresolved key yields `apiKey: undefined` — the caller decides whether that
// backend is usable (the convention is best-effort, not a hard requirement
// here, so the error surfaces at executor build with a clear message).
export function resolveBackendCredential(
  backend: string,
  opts: ResolveCredentialOptions,
): ResolvedCredential {
  const conv = BACKEND_CREDENTIAL[backend];
  const out: ResolvedCredential = {};

  const apiKey =
    opts.override?.key_ref !== undefined
      ? resolveMaybeRef(opts.override.key_ref, opts.loomHome, opts.env)
      : conv?.env !== undefined
        ? resolveSecret(conv.env, opts.loomHome, opts.env)
        : undefined;
  if (apiKey !== undefined && apiKey.length > 0) out.apiKey = apiKey;

  const baseUrl =
    opts.override?.base_url_ref !== undefined
      ? resolveMaybeRef(opts.override.base_url_ref, opts.loomHome, opts.env)
      : conv?.baseUrlEnv !== undefined
        ? nonEmpty(opts.env[conv.baseUrlEnv])
        : undefined;
  if (baseUrl !== undefined && baseUrl.length > 0) out.baseUrl = baseUrl;

  return out;
}

function nonEmpty(v: string | undefined): string | undefined {
  return v !== undefined && v.length > 0 ? v : undefined;
}
