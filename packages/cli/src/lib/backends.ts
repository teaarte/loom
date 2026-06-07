// Build a concrete `Executor` for a resolved backend — the per-spawn dispatch's
// construction half (the resolution half is `resolveBackend` in @loomfsm/config).
//
// Two shapes:
//   * `claude-code` → the sandboxed `claude -p` executor (a git worktree, or a
//     container when the toggle requires it) — the SAME executor the commands
//     built before per-spawn dispatch; it runs Claude Code's own tool harness,
//     self-diffs the worktree, and bills the subscription (no API key).
//   * a raw API backend (`openrouter` / `ollama` / `anthropic-sdk`) → a PLAIN
//     `createProviderExecutor` over the provider package, built with the
//     credential resolved from loom's secrets. No worktree, no file delta: a raw
//     model call is a decision-agent's single-shot answer. The provider package
//     is loaded lazily and is an OPTIONAL dependency — a build without it gives a
//     clean "install it" error rather than a hard import failure (same posture
//     as the external `claude` binary the worktree backend shells out to).

import type { ResolvedCredential } from "@loomfsm/config";
import type { Executor, SandboxSeed, SpawnUsage } from "@loomfsm/driver";
import type { ProviderShuttleIntent } from "@loomfsm/kernel";

import type { ContainerPlan } from "./container.js";
import type { SpawnTimeouts } from "./resilience.js";

// The sinks an executor wires its non-fatal notices / per-spawn usage / abort
// signal into (the command's stderr for `run`, the supervisor's audit for
// daemon/serve).
export interface BackendSinks {
  onNotice: (message: string) => void;
  onUsage: (usage: SpawnUsage) => void;
  signal?: AbortSignal;
}

export interface ClaudeCodeBackendOptions {
  project_dir: string;
  plan: ContainerPlan;
  permission_mode?: string;
  timeouts: SpawnTimeouts;
  // Static files to seed into the sandbox before the first spawn (e.g. the
  // active bundle's bundled knowledge). Forwarded to whichever Claude Code
  // backend the plan selects (worktree or container).
  sandbox_seed?: readonly SandboxSeed[];
}

// Read a numeric HTTP status off a thrown error across the SDKs' differing
// shapes: OpenAI / Anthropic SDK errors carry `status`; the `ollama` client's
// `ResponseError` carries `status_code`.
function errorStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as Record<string, unknown>;
  for (const key of ["status", "statusCode", "status_code"]) {
    const v = e[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

const RATE_LIMIT_TEXT = /rate.?limit|too many requests|quota|\b429\b/i;

// One detector across every raw backend (injected into createProviderExecutor):
// a 429 status, or a rate-limit phrase in the error message / the ollama
// `ResponseError.error` string. 429 alone is canonical; the text fallback
// catches a backend that words a quota wall without a numeric status.
export function detectProviderRateLimit(err: unknown): boolean {
  if (errorStatus(err) === 429) return true;
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  let extra = "";
  if (typeof err === "object" && err !== null) {
    const maybe = (err as Record<string, unknown>)["error"];
    if (typeof maybe === "string") extra = maybe;
  }
  return RATE_LIMIT_TEXT.test(`${message}\n${extra}`);
}

// Build the Claude Code backend executor (worktree or container per the toggle).
export async function buildClaudeCodeBackend(
  opts: ClaudeCodeBackendOptions,
  sinks: BackendSinks,
): Promise<Executor> {
  const driver = await import("@loomfsm/driver");
  if (opts.plan.useDocker) {
    return driver.createContainerExecutor({
      project_dir: opts.project_dir,
      ...opts.plan.container,
      ...opts.timeouts,
      onNotice: sinks.onNotice,
      onUsage: sinks.onUsage,
      ...(sinks.signal !== undefined ? { signal: sinks.signal } : {}),
      ...(opts.sandbox_seed !== undefined ? { sandbox_seed: opts.sandbox_seed } : {}),
    });
  }
  return driver.createClaudeCodeExecutor({
    project_dir: opts.project_dir,
    ...(opts.permission_mode !== undefined && opts.permission_mode !== ""
      ? { permission_mode: opts.permission_mode }
      : {}),
    ...opts.timeouts,
    onNotice: sinks.onNotice,
    onUsage: sinks.onUsage,
    ...(sinks.signal !== undefined ? { signal: sinks.signal } : {}),
    ...(opts.sandbox_seed !== undefined ? { sandbox_seed: opts.sandbox_seed } : {}),
  });
}

// Build a raw API backend executor from a credentialed provider. The provider
// package is an optional dependency, loaded lazily; an absent package or a
// missing credential surfaces a clean error.
export async function buildRawBackend(
  backend: string,
  creds: ResolvedCredential,
  sinks: BackendSinks,
): Promise<Executor> {
  const { createProviderExecutor } = await import("@loomfsm/driver");
  const wrap = (provider: import("@loomfsm/kernel").LLMProvider): Executor =>
    createProviderExecutor(provider, {
      detectRateLimit: detectProviderRateLimit,
      onUsage: sinks.onUsage,
    });

  switch (backend) {
    case "openrouter": {
      if (creds.apiKey === undefined) throw missingKey(backend, "OPENROUTER_API_KEY");
      let mod;
      try {
        mod = await import("@loomfsm/provider-openrouter");
      } catch {
        throw notInstalled(backend, "@loomfsm/provider-openrouter");
      }
      return wrap(
        mod.createOpenRouterProvider({
          apiKey: creds.apiKey,
          ...(creds.baseUrl !== undefined ? { baseURL: creds.baseUrl } : {}),
        }),
      );
    }
    case "ollama": {
      let mod;
      try {
        mod = await import("@loomfsm/provider-ollama");
      } catch {
        throw notInstalled(backend, "@loomfsm/provider-ollama");
      }
      return wrap(
        mod.createOllamaProvider({
          ...(creds.baseUrl !== undefined ? { baseURL: creds.baseUrl } : {}),
        }),
      );
    }
    case "anthropic-sdk": {
      if (creds.apiKey === undefined) throw missingKey(backend, "ANTHROPIC_API_KEY");
      let mod;
      try {
        mod = await import("@loomfsm/provider-anthropic-sdk");
      } catch {
        throw notInstalled(backend, "@loomfsm/provider-anthropic-sdk");
      }
      return wrap(mod.createAnthropicSdkProvider({ apiKey: creds.apiKey }));
    }
    default:
      throw new Error(
        `backend '${backend}' has no wired executor in this build (a CLI adapter for it is a later step)`,
      );
  }
}

// ---- Agentic CLI harness adapters (the non-CC file/shell tool loop) -------
//
// A harness adapter runs an AGENTIC agent (one that edits files) through an
// external agentic CLI, behind the same sandboxed worktree shell `claude -p`
// uses. It is selected by the per-spawn dispatch when a work-agent routes to a
// non-Claude backend; Claude Code already brings its own loop. The
// family→model-prefix + family→env-var maps below are backend/provider INFRA
// (cross-bundle), never a bundle's domain. Aider and opencode are both
// model-agnostic multiplexers; they differ only in their model-string prefixes.

// Provider family → Aider's litellm model prefix. `ollama_chat/` is litellm's
// chat-completions Ollama route (better than the legacy `ollama/`); `gemini/`
// is Google AI Studio. A family with no row passes through unprefixed.
const AIDER_MODEL_PREFIX: Readonly<Record<string, string>> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "gemini",
  openrouter: "openrouter",
  ollama: "ollama_chat",
};

// Provider family → opencode's provider id (`-m provider/model`). opencode names
// providers by the models.dev id; a local Ollama is a custom provider the user
// declares in `opencode.json` (conventionally id `ollama`).
const OPENCODE_MODEL_PREFIX: Readonly<Record<string, string>> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  openrouter: "openrouter",
  ollama: "ollama",
};

// Provider family → the env var the harness CLI reads its credential / base-URL
// from. loom resolves the secret by its own convention and re-exports it here
// under the name the CLI expects (Ollama wants OLLAMA_API_BASE, not loom's
// OLLAMA_HOST convention name). Both adapters read the same provider key vars.
const HARNESS_FAMILY_ENV: Readonly<Record<string, { key?: string; baseUrl?: string }>> = {
  anthropic: { key: "ANTHROPIC_API_KEY" },
  openai: { key: "OPENAI_API_KEY" },
  openrouter: { key: "OPENROUTER_API_KEY" },
  google: { key: "GEMINI_API_KEY" },
  ollama: { baseUrl: "OLLAMA_API_BASE" },
};

// Provider family → the loom raw-backend name whose credential convention
// applies. Used on an explicit harness pin (`backend: aider|opencode`, then the
// family comes from the agent's model ref); on the `auto` path the resolved
// backend already IS the family's raw backend.
const FAMILY_CRED_BACKEND: Readonly<Record<string, string>> = {
  anthropic: "anthropic-sdk",
  openai: "openai",
  openrouter: "openrouter",
  ollama: "ollama",
};

export function familyCredBackend(family: string | undefined): string {
  if (family === undefined) return "";
  return FAMILY_CRED_BACKEND[family] ?? family;
}

// Map a `provider:model` ref's (family, model) → Aider's `--model` string. A
// bare ref (no family) passes the model through unprefixed (the operator
// configured a full litellm model name).
export function aiderModelString(family: string | undefined, model: string): string {
  if (family === undefined) return model;
  const prefix = AIDER_MODEL_PREFIX[family] ?? family;
  return `${prefix}/${model}`;
}

// Map a `provider:model` ref's (family, model) → opencode's `-m provider/model`
// string. A bare ref passes through unprefixed (the operator configured a full
// `provider/model` already).
export function opencodeModelString(family: string | undefined, model: string): string {
  if (family === undefined) return model;
  const prefix = OPENCODE_MODEL_PREFIX[family] ?? family;
  return `${prefix}/${model}`;
}

// Overlay the resolved credential onto the child env under the var name the
// harness CLI expects for the family. Inherits the base env first, so a
// pre-exported key / base-URL still reaches the CLI when loom resolved none.
export function harnessChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  family: string | undefined,
  creds: ResolvedCredential,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const conv = family !== undefined ? HARNESS_FAMILY_ENV[family] : undefined;
  if (conv?.key !== undefined && creds.apiKey !== undefined) env[conv.key] = creds.apiKey;
  if (conv?.baseUrl !== undefined && creds.baseUrl !== undefined) env[conv.baseUrl] = creds.baseUrl;
  return env;
}

export interface HarnessBackendOptions {
  project_dir: string;
  // Per-spawn map intent → the CLI's `--model` string (built by the dispatcher
  // from the agent's configured ref, so a mixed-model backend works).
  resolveModel: (intent: ProviderShuttleIntent) => string;
  // Child env carrying the resolved provider credential (see `harnessChildEnv`).
  env: NodeJS.ProcessEnv;
  timeouts: SpawnTimeouts;
}

// Build the Aider work-agent executor (always a worktree — no container; the CLI
// edits files in the isolated tree the sandboxed shell provisions and the
// self-diff measures). The driver package is loaded lazily, same posture as the
// other backend builders.
export async function buildAiderBackend(
  opts: HarnessBackendOptions,
  sinks: BackendSinks,
): Promise<Executor> {
  const driver = await import("@loomfsm/driver");
  return driver.createAiderExecutor({
    project_dir: opts.project_dir,
    resolveModel: opts.resolveModel,
    env: opts.env,
    ...opts.timeouts,
    onNotice: sinks.onNotice,
    onUsage: sinks.onUsage,
    ...(sinks.signal !== undefined ? { signal: sinks.signal } : {}),
  });
}

// Build the opencode work-agent executor — sibling of `buildAiderBackend` over
// the same worktree shell, a different agentic CLI.
export async function buildOpencodeBackend(
  opts: HarnessBackendOptions,
  sinks: BackendSinks,
): Promise<Executor> {
  const driver = await import("@loomfsm/driver");
  return driver.createOpencodeExecutor({
    project_dir: opts.project_dir,
    resolveModel: opts.resolveModel,
    env: opts.env,
    ...opts.timeouts,
    onNotice: sinks.onNotice,
    onUsage: sinks.onUsage,
    ...(sinks.signal !== undefined ? { signal: sinks.signal } : {}),
  });
}

function missingKey(backend: string, envName: string): Error {
  return new Error(
    `backend '${backend}' needs a credential — set it once with 'loom secrets set ${envName} <value>' ` +
      `(or export ${envName})`,
  );
}

function notInstalled(backend: string, pkg: string): Error {
  return new Error(
    `backend '${backend}' requires the ${pkg} package, which is not installed in this build`,
  );
}
