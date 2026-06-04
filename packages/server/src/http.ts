// The HTTP transport — one more adapter over `drive()` + the supervisor
// registry, exactly as stdio sits behind MCP. It binds loopback, speaks JSON,
// and maps these routes onto the same compositions every transport shares:
//
//   GET  /                       → the dashboard SPA (prebuilt static assets; no auth)
//   GET  /assets/*               → the dashboard's hashed JS/CSS (no auth)
//   GET  /health                 → liveness (no auth)
//   POST /submit                 → submitTask  (create-task path)
//   GET  /projects               → registry + read-model for each
//   POST /projects               → register a project
//   GET  /projects/:id           → read-model
//   POST /projects/:id/answer    → answerGate  (deliver a human answer)
//   DELETE /projects/:id         → unregister
//   GET  /projects/:id/log       → SSE: status + log-tail snapshots
//   GET  /projects/:id/config    → the project's override config (masked)
//   PUT  /projects/:id/config    → write the project override config
//   GET  /projects/:id/agents    → the bundle roster + current model bindings
//
// Control-layer routes (the network face of the config stores the CLI writes,
// live only when a `loomHome` is injected; secrets masked on GET, write-only on PUT):
//   GET/PUT /config              → the global config (masked)
//   GET  /config/schema          → the config JSON Schema
//   GET  /secrets                → the secret names, masked
//   PUT  /secrets/:name          → store a secret (write-only)
//   GET  /workspace              → the project catalog + status
//   POST /workspace/projects     → add a project to the catalog
//   DELETE /workspace/projects/:id → remove a catalog entry
//   GET  /providers              → backends + provider families + availability
//
// No HTTP- or kernel-specific kernel API: every body delegates to submit /
// answer / the read-model / the config leaf. Auth (MVP) is localhost-bind + an optional bearer
// token (header `Authorization: Bearer …`, or `?token=` for the SSE stream
// which cannot set headers). Errors are one typed envelope `{ error: { code,
// message } }`; a thrown `ServerError` carries the status, anything else is a
// 500.
//
// Ambient timers/clock are fine here — this is transport, outside the kernel's
// replay graph.

import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve as resolvePath } from "node:path";

import type { Registry } from "@loomfsm/kernel";

import { answerGate, parseAnswer } from "./answer.js";
import {
  addWorkspaceProject,
  getConfigSchema,
  getGlobalConfig,
  getProjectAgents,
  getProjectConfig,
  getProviders,
  getWorkspace,
  listSecrets,
  putGlobalConfig,
  putProjectConfig,
  putSecret,
  removeWorkspaceProject,
} from "./config-routes.js";
import { serveDashboard } from "./dashboard/assets.js";
import { ServerError } from "./errors.js";
import { readLogTail } from "./log-tail.js";
import { readProjectStatus } from "./read-model.js";
import type { SupervisorRegistry } from "./registry.js";
import { submitTask } from "./submit.js";

// The control-layer (config / secrets / workspace) slice of the server deps —
// the SAME `@loomfsm/config` stores the CLI writes, reached over HTTP. Optional:
// a server built without a `loomHome` simply does not expose the config API.
export interface ConfigDeps {
  // The resolved global config home ($LOOM_HOME). When set, the config /
  // secrets / workspace / providers / agents routes are live.
  loomHome?: string;
  // A LIVE environment cell (config overlay under the real env). Read for secret
  // resolution + backend availability so an edit is seen on the next read; a
  // thunk (not a value) so it re-resolves rather than freezing at startup.
  // Default `() => process.env`.
  configEnv?: () => NodeJS.ProcessEnv;
  // Invalidate the deployment's per-project registry-routing cache after a config
  // write, so a long-running watcher rebuilds with the new model on the next
  // spawn. The server stays bundle-blind — it calls this thunk; the CLI wires it
  // to the bootstrap resolver. Omitted → no cache to bust (model still applies
  // on the dispatch path, which re-reads config per spawn).
  invalidateRegistry?: (projectDir?: string) => void;
  // Whether the Claude Code CLI is available (a PATH/login probe the CLI injects),
  // surfaced by `GET /providers`. Omitted → reported as "not probed".
  claudeAvailable?: () => boolean;
  // Override the dashboard's built-asset directory. Omitted → resolved from the
  // `@loomfsm/dashboard` workspace dependency. A test injects a fixture dir so it
  // can assert serving without running the front-end build.
  dashboardDir?: string;
}

export interface ControlServerDeps extends ConfigDeps {
  registry: SupervisorRegistry;
  // Resolve a project's FSM registry — the deployment's bundle/provider choice
  // (the CLI injects `assembleRegistry`).
  resolveRegistry: (projectDir: string) => Promise<Registry> | Registry;
  // When set, every API route requires this bearer token; the dashboard +
  // /health stay open so the page can load and prompt for it.
  token?: string;
  // Injectable wall clock for read-model ageing (tests pin it). Default Date.now.
  now?: () => number;
  // SSE snapshot cadence + log-tail size.
  sse_interval_ms?: number;
  log_tail_lines?: number;
  // Sink for unexpected (500) errors. Default a no-op.
  onError?: (err: unknown) => void;
}

export function createControlServer(deps: ControlServerDeps): Server {
  return createServer((req, res) => {
    void handle(req, res, deps).catch((err: unknown) => {
      deps.onError?.(err);
      if (!res.headersSent) sendJson(res, 500, { error: { code: "INTERNAL", message: "internal error" } });
      else res.end();
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: ControlServerDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  const parts = url.pathname.split("/").filter((s) => s.length > 0);
  const now = (): number => (deps.now ?? Date.now)();

  // ----- unauthenticated routes -----
  // The dashboard shell + its hashed assets load without a token (the page then
  // prompts for one); the API behind them stays gated. Non-asset GETs fall
  // through to API routing.
  if (method === "GET" && serveDashboard(res, url.pathname, deps.dashboardDir)) {
    return;
  }
  if (method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, projects: deps.registry.size() });
    return;
  }

  // ----- auth gate -----
  if (!authorized(req, url, deps.token)) {
    sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "a bearer token is required" } });
    return;
  }

  try {
    // POST /submit
    if (method === "POST" && url.pathname === "/submit") {
      const body = await readJsonBody(req);
      await routeSubmit(res, body, deps);
      return;
    }

    // ----- control-layer (config / schema / secrets / workspace / providers) -----
    // The network face of the `@loomfsm/config` stores the CLI also writes. Every
    // body delegates to the leaf; secrets are masked on GET, write-only on PUT.
    if (parts[0] === "config" && parts.length === 1) {
      if (method === "GET") {
        getGlobalConfig(res, deps);
        return;
      }
      if (method === "PUT") {
        const body = await readJsonBody(req);
        putGlobalConfig(res, body, deps);
        return;
      }
    }
    if (parts[0] === "config" && parts[1] === "schema" && parts.length === 2 && method === "GET") {
      getConfigSchema(res, deps);
      return;
    }
    if (parts[0] === "providers" && parts.length === 1 && method === "GET") {
      getProviders(res, deps);
      return;
    }
    // /secrets collection (masked list) + /secrets/:name (write-only).
    if (parts[0] === "secrets" && parts.length === 1 && method === "GET") {
      listSecrets(res, deps);
      return;
    }
    if (parts[0] === "secrets" && parts.length === 2 && method === "PUT") {
      const body = await readJsonBody(req);
      putSecret(res, parts[1] as string, body, deps);
      return;
    }
    // /workspace (catalog + status) + /workspace/projects (add/remove).
    if (parts[0] === "workspace" && parts.length === 1 && method === "GET") {
      await getWorkspace(res, deps);
      return;
    }
    if (parts[0] === "workspace" && parts[1] === "projects" && parts.length === 2 && method === "POST") {
      const body = await readJsonBody(req);
      addWorkspaceProject(res, body, deps);
      return;
    }
    if (parts[0] === "workspace" && parts[1] === "projects" && parts.length === 3 && method === "DELETE") {
      removeWorkspaceProject(res, parts[2] as string, deps);
      return;
    }

    // /projects collection
    if (parts[0] === "projects" && parts.length === 1) {
      if (method === "GET") {
        await routeListProjects(res, deps, now());
        return;
      }
      if (method === "POST") {
        const body = await readJsonBody(req);
        routeRegister(res, body, deps);
        return;
      }
    }

    // /projects/:id ( + /answer | /log )
    if (parts[0] === "projects" && parts.length >= 2) {
      const id = parts[1] as string;
      const sub = parts[2];

      if (sub === undefined && method === "GET") {
        await routeGetProject(res, id, deps, now());
        return;
      }
      if (sub === undefined && method === "DELETE") {
        await routeUnregister(res, id, deps);
        return;
      }
      if (sub === "answer" && method === "POST") {
        const body = await readJsonBody(req);
        await routeAnswer(res, id, body, deps);
        return;
      }
      if (sub === "log" && method === "GET") {
        streamLog(req, res, id, deps);
        return;
      }
      // Per-project control-layer routes: the override config + the bundle's
      // agent roster with its current model bindings (domain-blind).
      if (sub === "config" && method === "GET") {
        getProjectConfig(res, id, deps);
        return;
      }
      if (sub === "config" && method === "PUT") {
        const body = await readJsonBody(req);
        putProjectConfig(res, id, body, deps);
        return;
      }
      if (sub === "agents" && method === "GET") {
        await getProjectAgents(res, id, deps);
        return;
      }
    }

    sendJson(res, 404, { error: { code: "NOT_FOUND", message: `no route for ${method} ${url.pathname}` } });
  } catch (err) {
    if (err instanceof ServerError) {
      sendError(res, err);
      return;
    }
    throw err;
  }
}

// ----- route bodies ------------------------------------------------------

async function routeSubmit(
  res: ServerResponse,
  body: Record<string, unknown>,
  deps: ControlServerDeps,
): Promise<void> {
  const project = typeof body["project"] === "string" ? body["project"] : "";
  if (project.length === 0) throw new ServerError("PROJECT_REQUIRED", 400, "project is required");
  const task = typeof body["task"] === "string" ? body["task"] : "";

  // Resolve a registered project (by id or dir); auto-register a real dir on
  // first submit so an intake adapter can target a project the operator has
  // not pre-registered.
  let entry = deps.registry.resolve(project);
  if (entry === null) {
    const dir = resolvePath(project);
    if (!existsSync(dir)) {
      throw new ServerError("PROJECT_NOT_FOUND", 404, `project '${project}' is not registered and is not a directory`);
    }
    entry = deps.registry.register(dir);
  }

  const fsm = await resolveFsm(deps, entry.dir);
  const result = await submitTask(entry.dir, fsm, {
    task,
    ...(typeof body["policy_preset"] === "string" ? { policy_preset: body["policy_preset"] } : {}),
  });
  sendJson(res, 200, { id: entry.id, dir: entry.dir, ...result });
}

async function routeListProjects(res: ServerResponse, deps: ControlServerDeps, nowMs: number): Promise<void> {
  const listings = deps.registry.list();
  const out = await Promise.all(
    listings.map(async (p) => ({ id: p.id, dir: p.dir, status: await readProjectStatus(p.dir, nowMs) })),
  );
  sendJson(res, 200, out);
}

function routeRegister(res: ServerResponse, body: Record<string, unknown>, deps: ControlServerDeps): void {
  const dirRaw = typeof body["dir"] === "string" ? body["dir"] : "";
  if (dirRaw.length === 0) throw new ServerError("DIR_REQUIRED", 400, "dir is required");
  const dir = resolvePath(dirRaw);
  if (!existsSync(dir)) throw new ServerError("DIR_NOT_FOUND", 404, `${dir} does not exist`);
  const listing = deps.registry.register(dir);
  sendJson(res, 201, listing);
}

async function routeGetProject(res: ServerResponse, id: string, deps: ControlServerDeps, nowMs: number): Promise<void> {
  const entry = deps.registry.get(id);
  if (entry === null) throw new ServerError("PROJECT_NOT_FOUND", 404, `no registered project ${id}`);
  const status = await readProjectStatus(entry.dir, nowMs);
  sendJson(res, 200, { id: entry.id, dir: entry.dir, status });
}

async function routeUnregister(res: ServerResponse, id: string, deps: ControlServerDeps): Promise<void> {
  const removed = await deps.registry.unregister(id);
  if (!removed) throw new ServerError("PROJECT_NOT_FOUND", 404, `no registered project ${id}`);
  sendJson(res, 200, { id, unregistered: true });
}

async function routeAnswer(
  res: ServerResponse,
  id: string,
  body: Record<string, unknown>,
  deps: ControlServerDeps,
): Promise<void> {
  const entry = deps.registry.get(id);
  if (entry === null) throw new ServerError("PROJECT_NOT_FOUND", 404, `no registered project ${id}`);
  const args = parseAnswer(body);
  const fsm = await resolveFsm(deps, entry.dir);
  const result = await answerGate(entry.dir, fsm, args);
  sendJson(res, 200, { id: entry.id, ...result });
}

function streamLog(req: IncomingMessage, res: ServerResponse, id: string, deps: ControlServerDeps): void {
  const entry = deps.registry.get(id);
  if (entry === null) {
    sendJson(res, 404, { error: { code: "PROJECT_NOT_FOUND", message: `no registered project ${id}` } });
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const tailLines = deps.log_tail_lines ?? 60;
  const interval = deps.sse_interval_ms ?? 2000;
  let inFlight = false;
  const send = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const status = await readProjectStatus(entry.dir, (deps.now ?? Date.now)());
      const log = readLogTail(entry.dir, tailLines);
      res.write(`data: ${JSON.stringify({ status, log })}\n\n`);
    } catch {
      /* a transient read error skips one tick */
    } finally {
      inFlight = false;
    }
  };
  void send();
  const timer = setInterval(() => void send(), interval);
  req.on("close", () => clearInterval(timer));
}

// ----- helpers -----------------------------------------------------------

async function resolveFsm(deps: ControlServerDeps, dir: string): Promise<Registry> {
  try {
    return await deps.resolveRegistry(dir);
  } catch (err) {
    throw new ServerError(
      "REGISTRY_UNAVAILABLE",
      400,
      `could not load the pipeline for ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function authorized(req: IncomingMessage, url: URL, token: string | undefined): boolean {
  if (token === undefined || token.length === 0) return true;
  const header = req.headers["authorization"];
  if (typeof header === "string" && header === `Bearer ${token}`) return true;
  return url.searchParams.get("token") === token;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ServerError("BAD_JSON", 400, "request body must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ServerError("BAD_JSON", 400, "request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function sendError(res: ServerResponse, err: ServerError): void {
  sendJson(res, err.httpStatus, { error: { code: err.code, message: err.message } });
}
