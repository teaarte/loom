// The one layered resolver every face reads. It merges the config layers in the
// git/VS-Code precedence order and hands back both the merged view (for reads
// and for the non-model settings) and the per-layer model maps kept SEPARATE,
// so a caller can slot the legacy `.loom/providers.json` between global and
// project at the project rung:
//
//   built-in ← bundle defaults ← global (~/.config/loom/config.json)
//            ← [ .loom/providers.json ← .loom/loom.json ]   (project rung)
//            ← env (LOOM_*)
//
// The environment wins for the non-model settings via `envOverlay`: a `LOOM_*`
// map derived from the merged notify + resilience config that the caller merges
// UNDER the real environment, so existing env readers see config as defaults and
// the environment still beats it — nothing regresses for a 0.2.1 user.

import { AUTO_BACKEND } from "./capabilities.js";
import { resolveLoomHome } from "./paths.js";
import { resolveMaybeRef } from "./secrets.js";
import { readGlobalConfig, readProjectConfig } from "./stores.js";
import type {
  BackendCredentialConfig,
  BundleModelConfig,
  LoomConfig,
  NotifyConfig,
  ResilienceConfig,
  ResolvedConfig,
} from "./types.js";

export interface ResolveConfigOptions {
  projectDir: string;
  env?: NodeJS.ProcessEnv;
  // OS home for `~` expansion when computing the global store dir; defaults to
  // the OS home inside `resolveLoomHome`.
  home?: string;
}

export function resolveConfig(opts: ResolveConfigOptions): ResolvedConfig {
  const env = opts.env ?? process.env;
  const loomHome = resolveLoomHome(env, opts.home);

  const global = readGlobalConfig(loomHome);
  const project = readProjectConfig(opts.projectDir);
  const merged = mergeConfig(global, project);

  return {
    merged,
    layers: { global, project },
    envOverlay: buildEnvOverlay(merged, loomHome, env),
    home: loomHome,
    backend: merged.backend ?? AUTO_BACKEND,
  };
}

// Merge a lower-priority config under a higher-priority one. `backend` and
// scalar settings take the higher value when present; the bundle model map is
// merged per bundle, per agent (the higher layer wins for a given agent);
// notify / resilience merge field-wise.
export function mergeConfig(lower: LoomConfig, higher: LoomConfig): LoomConfig {
  const out: LoomConfig = {};

  const backend = higher.backend ?? lower.backend;
  if (backend !== undefined) out.backend = backend;

  const harness = higher.harness ?? lower.harness;
  if (harness !== undefined) out.harness = harness;

  const bundles = mergeBundles(lower.bundles, higher.bundles);
  if (bundles !== undefined) out.bundles = bundles;

  const notify = mergeFields<NotifyConfig>(lower.notify, higher.notify);
  if (notify !== undefined) out.notify = notify;

  const resilience = mergeFields<ResilienceConfig>(lower.resilience, higher.resilience);
  if (resilience !== undefined) out.resilience = resilience;

  const credentials = mergeCredentials(lower.credentials, higher.credentials);
  if (credentials !== undefined) out.credentials = credentials;

  return out;
}

// Merge per-backend credential overrides: the higher layer wins per FIELD within
// a backend (so a project can override the key_ref while inheriting a global
// base_url_ref).
function mergeCredentials(
  lower: Record<string, BackendCredentialConfig> | undefined,
  higher: Record<string, BackendCredentialConfig> | undefined,
): Record<string, BackendCredentialConfig> | undefined {
  if (lower === undefined && higher === undefined) return undefined;
  const names = new Set<string>([...Object.keys(lower ?? {}), ...Object.keys(higher ?? {})]);
  const out: Record<string, BackendCredentialConfig> = {};
  for (const name of names) {
    out[name] = { ...(lower?.[name] ?? {}), ...(higher?.[name] ?? {}) };
  }
  return out;
}

function mergeBundles(
  lower: Record<string, BundleModelConfig> | undefined,
  higher: Record<string, BundleModelConfig> | undefined,
): Record<string, BundleModelConfig> | undefined {
  if (lower === undefined && higher === undefined) return undefined;
  const names = new Set<string>([...Object.keys(lower ?? {}), ...Object.keys(higher ?? {})]);
  const out: Record<string, BundleModelConfig> = {};
  for (const name of names) {
    const lo = lower?.[name]?.agents ?? {};
    const hi = higher?.[name]?.agents ?? {};
    out[name] = { agents: { ...lo, ...hi } };
  }
  return out;
}

// Field-wise shallow merge where the higher layer's defined fields win. Returns
// undefined when neither layer is present.
function mergeFields<T extends object>(lower: T | undefined, higher: T | undefined): T | undefined {
  if (lower === undefined && higher === undefined) return undefined;
  return { ...(lower ?? {}), ...(higher ?? {}) } as T;
}

// Build the `LOOM_*` env overlay from the merged notify + resilience config.
// Secret-referenced values are resolved here; a value that does not resolve is
// omitted (that channel is simply not configured). The caller merges this UNDER
// the real environment.
export function buildEnvOverlay(
  config: LoomConfig,
  loomHome: string,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const overlay: Record<string, string> = {};
  const put = (key: string, value: string | undefined): void => {
    if (value !== undefined && value.length > 0) overlay[key] = value;
  };
  const putRef = (key: string, value: string | undefined): void => {
    if (value === undefined) return;
    put(key, resolveMaybeRef(value, loomHome, env));
  };

  const r = config.resilience;
  if (r !== undefined) {
    put("LOOM_RATE_LIMIT_WAIT", r.rate_limit_wait);
    put("LOOM_DRIVE_DEADLINE_MS", numStr(r.drive_deadline_ms));
    put("LOOM_SPAWN_SESSION_TIMEOUT_MS", numStr(r.spawn_session_timeout_ms));
    put("LOOM_SPAWN_IDLE_TIMEOUT_MS", numStr(r.spawn_idle_timeout_ms));
  }

  const n = config.notify;
  if (n !== undefined) {
    putRef("LOOM_NOTIFY_WEBHOOK_URL", n.webhook_url);
    putRef("LOOM_NOTIFY_SLACK_URL", n.slack_url);
    putRef("LOOM_NOTIFY_TELEGRAM_TOKEN", n.telegram_token);
    putRef("LOOM_NOTIFY_TELEGRAM_CHAT", n.telegram_chat);
    putRef("LOOM_NOTIFY_SCRIPT", n.script);
    put("LOOM_NOTIFY_TIMEOUT_MS", numStr(n.timeout_ms));
    if (n.events !== undefined && n.events.length > 0) {
      put("LOOM_NOTIFY_EVENTS", n.events.join(","));
    }
  }

  return overlay;
}

function numStr(n: number | undefined): string | undefined {
  return n !== undefined ? String(n) : undefined;
}
