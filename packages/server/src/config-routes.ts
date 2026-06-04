// The config / control-layer HTTP routes — the network face of the SAME
// `@loomfsm/config` stores the CLI verbs (`loom config / secrets / models /
// projects`) write. Both faces are equal clients of one resolver; neither owns
// the files. A UI (a later phase) consumes these; the vanilla dashboard is left
// untouched.
//
// Every body DELEGATES to `@loomfsm/config` (no IO or validation duplicated
// here). Secrets are MASKED on every GET that could carry one (config, project
// config, the secret list) and write-only on PUT — no read path ever returns a
// raw value. A config write fires the injected `invalidateRegistry` hook so a
// long-running watcher rebuilds its routing with the new model on the next spawn
// (the server stays bundle-blind — it calls a thunk; the CLI wires it).
//
// Domain-blind: `/projects/:id/agents` reads the loaded bundle's roster through
// the injected `resolveRegistry` and treats agent / tier names as DATA — it
// names no agent, tier, or bundle. The control plane never learns a domain.

import {
  addProject,
  bundleAgentMap,
  configJsonSchema,
  listProjects,
  maskConfig,
  maskSecret,
  parseLoomConfig,
  readGlobalConfig,
  readProjectConfig,
  readSecrets,
  reconcileMaskedConfig,
  removeProject,
  resolveBackendCredential,
  resolveConfig,
  resolveModelRef,
  validatePair,
  writeGlobalConfig,
  writeProjectConfig,
  writeSecrets,
  AUTO_BACKEND,
  BACKEND_CAPABILITIES,
  type BundleRoster,
  type LoomConfig,
} from "@loomfsm/config";
import type { Registry } from "@loomfsm/kernel";
import type { ServerResponse } from "node:http";
import { resolve as resolvePath } from "node:path";

import { ServerError } from "./errors.js";
import type { ConfigDeps, ControlServerDeps } from "./http.js";
import { readProjectStatus } from "./read-model.js";
import { projectId } from "./registry.js";

// ----- shared helpers ------------------------------------------------------

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

// Resolve the config home or refuse cleanly. The routes mount regardless; an
// unconfigured deployment gets a clear 501 instead of a 404 that looks like a typo.
function requireConfig(deps: ConfigDeps): string {
  if (deps.loomHome === undefined || deps.loomHome.length === 0) {
    throw new ServerError("CONFIG_UNAVAILABLE", 501, "the config API is not enabled on this server");
  }
  return deps.loomHome;
}

// The live environment cell (config overlay under the real env), pinned to the
// server's home so resolution reads the SAME store the routes write. Re-resolved
// each call so an edit is seen on the next read (no startup freeze).
function configEnv(deps: ControlServerDeps, loomHome: string): NodeJS.ProcessEnv {
  const base = deps.configEnv !== undefined ? deps.configEnv() : process.env;
  return { ...base, LOOM_HOME: loomHome };
}

function nowMs(deps: ControlServerDeps): number {
  return (deps.now ?? Date.now)();
}

// Resolve a project id (or a registered/catalog id) to its dir: the live
// supervised set first, then the catalog (a project a user has worked on but is
// not currently supervised still has editable config).
function resolveProjectDir(id: string, deps: ControlServerDeps, loomHome: string): string {
  const live = deps.registry.get(id);
  if (live !== null) return live.dir;
  const cataloged = listProjects(loomHome).find((p) => p.id === id);
  if (cataloged !== undefined) return cataloged.dir;
  throw new ServerError("PROJECT_NOT_FOUND", 404, `no project ${id}`);
}

function readConfigOr400(read: () => LoomConfig): LoomConfig {
  try {
    return read();
  } catch (err) {
    // A hand-corrupted file on disk surfaces as a clear 400 rather than a 500.
    throw new ServerError("BAD_CONFIG", 400, (err as Error).message);
  }
}

function parseConfigOr400(body: Record<string, unknown>, label: string): LoomConfig {
  try {
    return parseLoomConfig(body, label);
  } catch (err) {
    throw new ServerError("BAD_CONFIG", 400, (err as Error).message);
  }
}

// Validate every model ref in the bundle-namespaced map against the configured
// backend — the same gate `loom models set` applies, so the API never stores a
// pairing that can't run.
function rejectIncompatibleModels(config: LoomConfig): void {
  const backend = config.backend ?? AUTO_BACKEND;
  for (const bundle of Object.values(config.bundles ?? {})) {
    for (const ref of Object.values(bundle.agents ?? {})) {
      const pair = validatePair(backend, ref);
      if (!pair.ok) throw new ServerError("BAD_CONFIG", 400, pair.message);
    }
  }
}

function requireStringBody(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ServerError("BAD_REQUEST", 400, `'${key}' is required`);
  }
  return v;
}

// ----- GET/PUT /config (global) --------------------------------------------

export function getGlobalConfig(res: ServerResponse, deps: ControlServerDeps): void {
  const loomHome = requireConfig(deps);
  const current = readConfigOr400(() => readGlobalConfig(loomHome));
  sendJson(res, 200, maskConfig(current));
}

export function putGlobalConfig(res: ServerResponse, body: Record<string, unknown>, deps: ControlServerDeps): void {
  const loomHome = requireConfig(deps);
  const incoming = parseConfigOr400(body, "config (PUT /config)");
  rejectIncompatibleModels(incoming);
  const stored = readConfigOr400(() => readGlobalConfig(loomHome));
  const reconciled = reconcileMaskedConfig(incoming, stored);
  writeGlobalConfig(loomHome, reconciled);
  deps.invalidateRegistry?.();
  sendJson(res, 200, maskConfig(reconciled));
}

// ----- GET /config/schema --------------------------------------------------

export function getConfigSchema(res: ServerResponse, deps: ControlServerDeps): void {
  requireConfig(deps);
  sendJson(res, 200, configJsonSchema());
}

// ----- GET/PUT /projects/:id/config (project override) ---------------------

export function getProjectConfig(res: ServerResponse, id: string, deps: ControlServerDeps): void {
  const loomHome = requireConfig(deps);
  const dir = resolveProjectDir(id, deps, loomHome);
  const current = readConfigOr400(() => readProjectConfig(dir));
  sendJson(res, 200, maskConfig(current));
}

export function putProjectConfig(res: ServerResponse, id: string, body: Record<string, unknown>, deps: ControlServerDeps): void {
  const loomHome = requireConfig(deps);
  const dir = resolveProjectDir(id, deps, loomHome);
  const incoming = parseConfigOr400(body, "project config (PUT /projects/:id/config)");
  rejectIncompatibleModels(incoming);
  const stored = readConfigOr400(() => readProjectConfig(dir));
  const reconciled = reconcileMaskedConfig(incoming, stored);
  writeProjectConfig(dir, reconciled);
  deps.invalidateRegistry?.(dir);
  sendJson(res, 200, maskConfig(reconciled));
}

// ----- GET /projects/:id/agents --------------------------------------------
// The loaded bundle's roster + each agent's CURRENT model binding (override vs
// bundle default), mirroring `loom models list`. Agent / tier names are DATA
// read off the resolved registry — nothing here is hardcoded to a bundle.

export async function getProjectAgents(res: ServerResponse, id: string, deps: ControlServerDeps): Promise<void> {
  const loomHome = requireConfig(deps);
  const dir = resolveProjectDir(id, deps, loomHome);

  let registry: Registry;
  try {
    registry = await deps.resolveRegistry(dir);
  } catch (err) {
    throw new ServerError("REGISTRY_UNAVAILABLE", 400, `could not load the pipeline for ${dir}: ${(err as Error).message}`);
  }

  const roster: BundleRoster = {
    name: registry.bundle.name,
    agents: registry.bundle.agents.map((a) => ({
      name: a.name,
      ...(a.default_model !== undefined ? { default_model: a.default_model } : {}),
    })),
    ...(registry.bundle.default_model_tiers !== undefined
      ? { default_model_tiers: registry.bundle.default_model_tiers }
      : {}),
    ...(registry.bundle.default_provider !== undefined ? { default_provider: registry.bundle.default_provider } : {}),
  };

  const resolved = resolveConfig({ projectDir: dir, env: configEnv(deps, loomHome) });
  const overrides = bundleAgentMap(resolved.merged, roster.name);
  const tiers = roster.default_model_tiers;

  const agents = roster.agents.map((a) => {
    const override = overrides[a.name];
    if (override !== undefined) {
      const r = resolveModelRef(override, tiers);
      return { agent: a.name, ref: override, source: "override" as const, model: r.model, ...(r.family !== undefined ? { family: r.family } : {}) };
    }
    if (a.default_model !== undefined) {
      const r = resolveModelRef(a.default_model, tiers);
      return { agent: a.name, ref: a.default_model, source: "bundle-default" as const, model: r.model, ...(r.family !== undefined ? { family: r.family } : {}) };
    }
    return { agent: a.name, ref: null, source: "unset" as const, model: null };
  });

  sendJson(res, 200, { bundle: roster.name, agents });
}

// ----- GET /providers ------------------------------------------------------
// Each backend, its provider families (from the static infra table), and a
// best-effort availability signal the server can know WITHOUT spawning: an
// API-key backend reports whether its credential resolves; Claude Code reports an
// injected presence probe; everything else (local / external CLI) is reported as
// not probed rather than guessed. These are cross-bundle INFRA names — naming
// them does not break genericity (which is about bundle/agent/tier blindness).

export function getProviders(res: ServerResponse, deps: ControlServerDeps): void {
  const loomHome = requireConfig(deps);
  const env = configEnv(deps, loomHome);
  const config = readConfigOr400(() => readGlobalConfig(loomHome));

  const providers = Object.entries(BACKEND_CAPABILITIES).map(([backend, families]) => {
    const av = availability(backend, deps, loomHome, env, config);
    return { backend, families: [...families], ...av };
  });
  // Per-task Docker availability (P4) — the CLI injects the probe; omitted when
  // the deployment cannot run containers, so the UI simply hides the checkbox.
  const docker = deps.dockerCapability?.();
  sendJson(res, 200, {
    backend_mode: config.backend ?? AUTO_BACKEND,
    providers,
    ...(docker !== undefined ? { docker } : {}),
  });
}

const API_KEY_BACKENDS = new Set(["anthropic-sdk", "openrouter", "openai"]);

function availability(
  backend: string,
  deps: ControlServerDeps,
  loomHome: string,
  env: NodeJS.ProcessEnv,
  config: LoomConfig,
): { available: boolean | null; reason?: string } {
  if (backend === "claude-code") {
    if (deps.claudeAvailable === undefined) return { available: null, reason: "CLI presence not probed" };
    return deps.claudeAvailable()
      ? { available: true }
      : { available: false, reason: "the Claude Code CLI was not found or you are not signed in" };
  }
  if (API_KEY_BACKENDS.has(backend)) {
    const override = config.credentials?.[backend];
    const cred = resolveBackendCredential(backend, { loomHome, env, ...(override !== undefined ? { override } : {}) });
    return cred.apiKey !== undefined
      ? { available: true }
      : { available: false, reason: `no API credential configured for '${backend}'` };
  }
  // ollama (local), codex / gemini / aider / opencode (external CLIs): the server
  // cannot know without spawning, so it reports honestly rather than guessing.
  return { available: null, reason: "availability not probed (local or external-CLI backend)" };
}

// ----- GET /providers/:backend/models --------------------------------------
// A backend's models, listed LIVE: OpenRouter / Ollama hit their HTTP APIs,
// the Anthropic family returns a known static set, everything else returns []
// (the UI then falls back to free-text). Uses node's global `fetch` only — no
// new runtime dep — with a short timeout so an unreachable backend degrades to
// an empty list rather than hanging the route, and a brief in-process cache so
// repeated dropdown opens don't re-hit the network. Returns model REFS already
// in `family:model` form, so the model-map editor can store them verbatim.

interface ModelCacheEntry {
  at: number;
  models: string[];
  reason?: string;
}
const modelCache = new Map<string, ModelCacheEntry>();
const MODEL_CACHE_TTL_MS = 60_000;
const MODEL_FETCH_TIMEOUT_MS = 5_000;

// A known Anthropic family set (the latest tiers) — a static catalog for the
// claude-code / anthropic-sdk backends, which have no public list endpoint here.
const ANTHROPIC_MODELS = ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"];

export async function getBackendModels(res: ServerResponse, backend: string, deps: ControlServerDeps): Promise<void> {
  const loomHome = requireConfig(deps);
  const result = await resolveBackendModels(backend, deps, loomHome);
  sendJson(res, 200, { backend, models: result.models, ...(result.reason !== undefined ? { reason: result.reason } : {}) });
}

async function resolveBackendModels(
  backend: string,
  deps: ControlServerDeps,
  loomHome: string,
): Promise<{ models: string[]; reason?: string }> {
  const now = nowMs(deps);
  const cached = modelCache.get(backend);
  if (cached !== undefined && now - cached.at < MODEL_CACHE_TTL_MS) {
    return { models: cached.models, ...(cached.reason !== undefined ? { reason: cached.reason } : {}) };
  }
  const fresh = await fetchBackendModels(backend, deps, loomHome);
  modelCache.set(backend, { at: now, models: fresh.models, ...(fresh.reason !== undefined ? { reason: fresh.reason } : {}) });
  return fresh;
}

async function fetchBackendModels(
  backend: string,
  deps: ControlServerDeps,
  loomHome: string,
): Promise<{ models: string[]; reason?: string }> {
  const env = configEnv(deps, loomHome);
  if (backend === "anthropic-sdk" || backend === "claude-code") {
    return { models: ANTHROPIC_MODELS.map((m) => `anthropic:${m}`) };
  }
  const config = readConfigOr400(() => readGlobalConfig(loomHome));
  if (backend === "openrouter") {
    const override = config.credentials?.["openrouter"];
    const cred = resolveBackendCredential("openrouter", { loomHome, env, ...(override !== undefined ? { override } : {}) });
    return await fetchOpenRouterModels(cred.apiKey);
  }
  if (backend === "ollama") {
    const override = config.credentials?.["ollama"];
    const cred = resolveBackendCredential("ollama", { loomHome, env, ...(override !== undefined ? { override } : {}) });
    return await fetchOllamaModels(cred.baseUrl ?? env["OLLAMA_HOST"]);
  }
  return { models: [], reason: `live model listing is not available for backend '${backend}'` };
}

async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MODEL_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOpenRouterModels(apiKey: string | undefined): Promise<{ models: string[]; reason?: string }> {
  try {
    const headers: Record<string, string> = {};
    if (apiKey !== undefined && apiKey.length > 0) headers["authorization"] = `Bearer ${apiKey}`;
    const res = await fetchWithTimeout("https://openrouter.ai/api/v1/models", headers);
    if (!res.ok) return { models: [], reason: `OpenRouter returned HTTP ${res.status}` };
    const json = (await res.json()) as { data?: { id?: unknown }[] };
    const models = (json.data ?? [])
      .map((d) => (typeof d.id === "string" ? `openrouter:${d.id}` : null))
      .filter((x): x is string => x !== null);
    return { models };
  } catch (err) {
    return { models: [], reason: `could not reach OpenRouter: ${(err as Error).message}` };
  }
}

async function fetchOllamaModels(host: string | undefined): Promise<{ models: string[]; reason?: string }> {
  const base = (host !== undefined && host.length > 0 ? host : "http://localhost:11434").replace(/\/+$/, "");
  try {
    const res = await fetchWithTimeout(`${base}/api/tags`, {});
    if (!res.ok) return { models: [], reason: `Ollama returned HTTP ${res.status}` };
    const json = (await res.json()) as { models?: { name?: unknown }[] };
    const models = (json.models ?? [])
      .map((m) => (typeof m.name === "string" ? `ollama:${m.name}` : null))
      .filter((x): x is string => x !== null);
    return { models };
  } catch (err) {
    return { models: [], reason: `could not reach Ollama at ${base}: ${(err as Error).message}` };
  }
}

// ----- GET /secrets + PUT /secrets/:name -----------------------------------

export function listSecrets(res: ServerResponse, deps: ControlServerDeps): void {
  const loomHome = requireConfig(deps);
  let secrets: Record<string, string>;
  try {
    secrets = readSecrets(loomHome);
  } catch (err) {
    throw new ServerError("BAD_CONFIG", 400, (err as Error).message);
  }
  const masked: Record<string, string> = {};
  for (const name of Object.keys(secrets).sort()) masked[name] = maskSecret(secrets[name] ?? "");
  sendJson(res, 200, { secrets: masked });
}

export function putSecret(res: ServerResponse, name: string, body: Record<string, unknown>, deps: ControlServerDeps): void {
  const loomHome = requireConfig(deps);
  if (name.length === 0) throw new ServerError("BAD_REQUEST", 400, "a secret name is required");
  const value = requireStringBody(body, "value");
  let secrets: Record<string, string>;
  try {
    secrets = readSecrets(loomHome);
  } catch (err) {
    throw new ServerError("BAD_CONFIG", 400, (err as Error).message);
  }
  secrets[name] = value;
  writeSecrets(loomHome, secrets);
  // Write-only: report the masked form, never echo the raw value.
  sendJson(res, 200, { name, stored: true, masked: maskSecret(value), ref: `secret:${name}` });
}

// ----- GET /workspace + POST/DELETE /workspace/projects --------------------

export async function getWorkspace(res: ServerResponse, deps: ControlServerDeps): Promise<void> {
  const loomHome = requireConfig(deps);
  const entries = listProjects(loomHome);
  const now = nowMs(deps);
  const projects = await Promise.all(
    entries.map(async (e) => ({ ...e, status: await readProjectStatus(e.dir, now) })),
  );
  sendJson(res, 200, { projects });
}

export function addWorkspaceProject(res: ServerResponse, body: Record<string, unknown>, deps: ControlServerDeps): void {
  const loomHome = requireConfig(deps);
  const dir = resolvePath(requireStringBody(body, "dir"));
  const id = projectId(dir);
  const label = typeof body["label"] === "string" ? body["label"] : undefined;
  const bundle = typeof body["bundle"] === "string" ? body["bundle"] : undefined;
  const addedAt = new Date(nowMs(deps)).toISOString();
  // addProject is the catalog upsert (re-add preserves added_at) — delegated, the
  // server duplicates no catalog logic.
  addProject(loomHome, {
    id,
    dir,
    added_at: addedAt,
    ...(label !== undefined ? { label } : {}),
    ...(bundle !== undefined ? { bundle } : {}),
  });
  sendJson(res, 201, { id, dir, ...(label !== undefined ? { label } : {}), ...(bundle !== undefined ? { bundle } : {}) });
}

export function removeWorkspaceProject(res: ServerResponse, id: string, deps: ControlServerDeps): void {
  const loomHome = requireConfig(deps);
  const { removed } = removeProject(loomHome, id);
  if (!removed) throw new ServerError("PROJECT_NOT_FOUND", 404, `no catalog entry ${id}`);
  sendJson(res, 200, { id, removed: true });
}
