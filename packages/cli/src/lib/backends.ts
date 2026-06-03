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
import type { Executor, SpawnUsage } from "@loomfsm/driver";

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
