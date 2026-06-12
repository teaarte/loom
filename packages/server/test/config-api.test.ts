// The config / control-layer HTTP API end to end, over a REAL `createControlServer`
// (loopback, ephemeral port) + a REAL temp $LOOM_HOME store + REAL project stores
// — no mocks. Proves: the dispatch surface scales to the control-layer routes, the
// auth gate covers them, secrets are masked on every GET and write-only on PUT, a
// malformed / incompatible body is a typed 400, a masked round-trip never clobbers
// the stored secret, and — the release gate — the providers / agents / config path
// resolves against a FABRICATED non-code roster with zero hardcoded names.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import { readGlobalConfig, readProjectConfig, readSecrets, type LoomConfig } from "@loomfsm/config";
import type { Registry } from "@loomfsm/kernel";
import type { Server } from "node:http";

import { createControlServer } from "../src/http.js";
import { SupervisorRegistry } from "../src/registry.js";
import { cleanup, freshProject, rosterRegistry, spawnRegistry, tempStateDir } from "./fixtures.js";

const TOKEN = "dev-token";
const RAW_TG_TOKEN = "1234567890:AAH-super-secret-bot-token";

// Per-dir registries so a project can resolve a fabricated roster (genericity).
const registries = new Map<string, Registry>();
function resolveRegistry(dir: string): Registry {
  return registries.get(dir) ?? registries.get(resolve(dir)) ?? spawnRegistry();
}

interface ServerOpts {
  loomHome?: string;
  claudeAvailable?: () => boolean;
  // Sandbox the add-project allowlist enrollment at a tmpfile so the suite never
  // touches the real `~/.loom/projects.allow`.
  allowlistPath?: string;
}
function startServer(opts: ServerOpts): Promise<{ base: string; server: Server }> {
  const registry = new SupervisorRegistry({
    resolveRegistry,
    buildExecutor: () => ({ execute: async () => ({ agent_output: "" }) }),
    stateDir: tempStateDir(),
  });
  const server = createControlServer({
    registry,
    resolveRegistry,
    token: TOKEN,
    ...(opts.loomHome !== undefined ? { loomHome: opts.loomHome } : {}),
    ...(opts.allowlistPath !== undefined ? { allowlistPath: opts.allowlistPath } : {}),
    ...(opts.claudeAvailable !== undefined ? { claudeAvailable: opts.claudeAvailable } : {}),
    invalidateRegistry: (dir) => invalidated.push(dir === undefined ? "*" : dir),
  });
  return new Promise((res) => {
    server.listen(0, "127.0.0.1", () => {
      res({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server });
    });
  });
}

interface Resp {
  status: number;
  json: any;
  text: string;
}
async function req(base: string, method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<Resp> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token !== undefined) headers["authorization"] = `Bearer ${opts.token}`;
  const res = await fetch(base + path, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}

let loomHome: string;
let allowFile: string;
let base: string;
let server: Server;
let noConfigBase: string;
let noConfigServer: Server;
const invalidated: string[] = [];
const projectDirs: string[] = [];

before(async () => {
  loomHome = mkdtempSync(join(tmpdir(), "loom-config-api-"));
  allowFile = join(loomHome, "projects.allow");
  ({ base, server } = await startServer({ loomHome, allowlistPath: allowFile, claudeAvailable: () => true }));
  ({ base: noConfigBase, server: noConfigServer } = await startServer({}));
});

after(() => {
  server.close();
  noConfigServer.close();
  rmSync(loomHome, { recursive: true, force: true });
  for (const d of projectDirs) cleanup(d);
});

describe("config api — auth + availability", () => {
  it("requires the bearer token (401) on GET /config", async () => {
    const res = await req(base, "GET", "/config");
    assert.equal(res.status, 401);
    assert.equal(res.json.error.code, "UNAUTHORIZED");
  });

  it("reports CONFIG_UNAVAILABLE (501) when the server has no loomHome", async () => {
    for (const path of ["/config", "/config/schema", "/secrets", "/workspace", "/providers"]) {
      const res = await req(noConfigBase, "GET", path, { token: TOKEN });
      assert.equal(res.status, 501, `${path} should be 501`);
      assert.equal(res.json.error.code, "CONFIG_UNAVAILABLE");
    }
  });

  it("GET /config on a fresh home is the empty config", async () => {
    const res = await req(base, "GET", "/config", { token: TOKEN });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, {});
  });
});

describe("config api — /config PUT validation + mask round-trip", () => {
  it("rejects a malformed document with a typed 400", async () => {
    const res = await req(base, "PUT", "/config", { token: TOKEN, body: { backend: 123 } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, "BAD_CONFIG");
  });

  it("rejects an incompatible (backend, model) pair at entry", async () => {
    const res = await req(base, "PUT", "/config", {
      token: TOKEN,
      body: { backend: "codex", bundles: { "code-fixture": { agents: { impl: "google:gemini-2.x" } } } },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, "BAD_CONFIG");
    assert.match(res.json.error.message, /codex|google/i);
  });

  it("PUT persists the raw value; GET masks it; the raw never appears on a read", async () => {
    const put = await req(base, "PUT", "/config", {
      token: TOKEN,
      body: { backend: "auto", notify: { telegram_token: RAW_TG_TOKEN, telegram_chat: "42" } },
    });
    assert.equal(put.status, 200);
    assert.notEqual(put.json.notify.telegram_token, RAW_TG_TOKEN);
    assert.ok(put.json.notify.telegram_token.includes("*"));

    const stored = readGlobalConfig(loomHome) as LoomConfig;
    assert.equal(stored.notify?.telegram_token, RAW_TG_TOKEN);
    assert.equal(stored.notify?.telegram_chat, "42");

    const get = await req(base, "GET", "/config", { token: TOKEN });
    assert.equal(get.status, 200);
    assert.ok(!get.text.includes(RAW_TG_TOKEN), "raw secret must never appear in a GET body");
  });

  it("a masked round-trip preserves the stored secret; a real edit + cache bust", async () => {
    const get = await req(base, "GET", "/config", { token: TOKEN });
    const back = await req(base, "PUT", "/config", { token: TOKEN, body: get.json });
    assert.equal(back.status, 200);
    assert.equal((readGlobalConfig(loomHome) as LoomConfig).notify?.telegram_token, RAW_TG_TOKEN);

    const before = invalidated.length;
    const edit = await req(base, "PUT", "/config", {
      token: TOKEN,
      body: { backend: "auto", notify: { telegram_token: "secret:tg_bot" } },
    });
    assert.equal(edit.status, 200);
    assert.equal((readGlobalConfig(loomHome) as LoomConfig).notify?.telegram_token, "secret:tg_bot");
    assert.equal(edit.json.notify.telegram_token, "secret:tg_bot", "a secret: ref is a pointer, shown verbatim");
    assert.ok(invalidated.length > before, "PUT /config must invalidate the registry cache");
  });
});

describe("config api — /config/schema", () => {
  it("emits a JSON Schema derived from the Zod schema (open-keyed, generic)", async () => {
    const res = await req(base, "GET", "/config/schema", { token: TOKEN });
    assert.equal(res.status, 200);
    assert.equal(res.json.type, "object");
    assert.ok(res.json.properties.backend, "schema exposes the backend field");
    assert.ok(res.json.properties.bundles, "schema exposes the bundle-namespaced model map");
    // No agent/tier/bundle name is baked into the schema — `bundles`/`agents` are
    // open records (additionalProperties), so any roster validates.
    assert.ok(!res.text.includes("code-fixture"));
  });
});

describe("config api — secrets (masked GET, write-only PUT)", () => {
  it("PUT stores a secret write-only; GET lists masked; the raw never leaks", async () => {
    const put = await req(base, "PUT", "/secrets/OPENROUTER_API_KEY", {
      token: TOKEN,
      body: { value: "sk-or-SUPER-secret-key-9999" },
    });
    assert.equal(put.status, 200);
    assert.equal(put.json.stored, true);
    assert.equal(put.json.ref, "secret:OPENROUTER_API_KEY");
    assert.ok(!put.text.includes("SUPER-secret-key-9999"), "PUT must not echo the raw secret");

    const list = await req(base, "GET", "/secrets", { token: TOKEN });
    assert.equal(list.status, 200);
    assert.ok(list.json.secrets.OPENROUTER_API_KEY.includes("*"));
    assert.ok(!list.text.includes("SUPER-secret-key-9999"), "GET /secrets must never reveal the raw value");

    // The raw value did land in the store on disk (it is usable at the point of use).
    assert.equal(readSecrets(loomHome)["OPENROUTER_API_KEY"], "sk-or-SUPER-secret-key-9999");
  });

  it("PUT /secrets/:name rejects a missing value (400)", async () => {
    const res = await req(base, "PUT", "/secrets/SOME_KEY", { token: TOKEN, body: {} });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, "BAD_REQUEST");
  });
});

describe("config api — providers (infra table + availability)", () => {
  it("lists every backend with its families; availability reflects creds + the CC probe", async () => {
    const res = await req(base, "GET", "/providers", { token: TOKEN });
    assert.equal(res.status, 200);
    const byName = new Map<string, any>(res.json.providers.map((p: any) => [p.backend, p]));
    // Families come from the static infra table.
    assert.deepEqual(byName.get("claude-code").families, ["anthropic"]);
    assert.ok(byName.get("aider").families.includes("openrouter"));
    // CC availability = the injected probe (true in this server).
    assert.equal(byName.get("claude-code").available, true);
    // openrouter has a credential now (the secret set above) → available.
    assert.equal(byName.get("openrouter").available, true);
    // anthropic-sdk has no key configured → not available, with a reason.
    assert.equal(byName.get("anthropic-sdk").available, false);
    assert.ok(byName.get("anthropic-sdk").reason);
  });
});

describe("config api — genericity: fabricated non-code roster, zero hardcode", () => {
  let id: string;
  let dir: string;
  const BUNDLE = "research-bundle";

  before(async () => {
    dir = await freshProject("loom-config-generic-");
    projectDirs.push(dir);
    registries.set(dir, rosterRegistry(BUNDLE, [
      { name: "scout", default_model: "fast" },
      { name: "writer", default_model: "premium" },
    ], { fast: "haiku-x", premium: "opus-x" }));
    const add = await req(base, "POST", "/workspace/projects", { token: TOKEN, body: { dir, label: "research" } });
    assert.equal(add.status, 201);
    assert.equal(add.json.enrolled, true, "adding a project authorizes it");
    id = add.json.id;
  });

  it("POST /workspace/projects enrolls the dir into the allowlist (no manual edit)", () => {
    // The add-project gesture doubles as authorization — the canonical dir is now
    // in the same allowlist the drive routes gate on, so the first run won't 403.
    const body = readFileSync(allowFile, "utf8");
    assert.ok(body.includes(realpathSync(dir)), "the added project's canonical dir is allowlisted");
  });

  it("GET /workspace lists the catalog entry with a domain-blind status", async () => {
    const res = await req(base, "GET", "/workspace", { token: TOKEN });
    assert.equal(res.status, 200);
    const entry = res.json.projects.find((p: any) => p.id === id);
    assert.ok(entry, "the added project is in the catalog");
    assert.equal(entry.label, "research");
    assert.equal(entry.status.has_task, false);
  });

  it("GET /projects/:id/agents reflects the FABRICATED roster (names as data)", async () => {
    const res = await req(base, "GET", `/projects/${id}/agents`, { token: TOKEN });
    assert.equal(res.status, 200);
    assert.equal(res.json.bundle, BUNDLE);
    const byAgent = new Map<string, any>(res.json.agents.map((a: any) => [a.agent, a]));
    assert.deepEqual([...byAgent.keys()].sort(), ["scout", "writer"]);
    // Tier expansion via the fabricated bundle's tier map — no code-bundle assumption.
    assert.equal(byAgent.get("scout").source, "bundle-default");
    assert.equal(byAgent.get("scout").model, "haiku-x");
    assert.equal(byAgent.get("writer").model, "opus-x");
  });

  it("PUT /projects/:id/config binds a model under the fabricated bundle namespace", async () => {
    const put = await req(base, "PUT", `/projects/${id}/config`, {
      token: TOKEN,
      body: { bundles: { [BUNDLE]: { agents: { scout: "openrouter:deepseek" } } } },
    });
    assert.equal(put.status, 200);
    // Persisted to the project override file under the fabricated bundle name.
    const stored = readProjectConfig(dir) as LoomConfig;
    assert.equal(stored.bundles?.[BUNDLE]?.agents?.scout, "openrouter:deepseek");

    // /agents now reports the override resolved with its family — generic path.
    const agents = await req(base, "GET", `/projects/${id}/agents`, { token: TOKEN });
    const scout = agents.json.agents.find((a: any) => a.agent === "scout");
    assert.equal(scout.source, "override");
    assert.equal(scout.ref, "openrouter:deepseek");
    assert.equal(scout.family, "openrouter");
    assert.equal(scout.model, "deepseek");
  });

  it("DELETE /workspace/projects/:id removes the catalog entry", async () => {
    const del = await req(base, "DELETE", `/workspace/projects/${id}`, { token: TOKEN });
    assert.equal(del.status, 200);
    assert.equal(del.json.removed, true);
    const list = await req(base, "GET", "/workspace", { token: TOKEN });
    assert.ok(!list.json.projects.some((p: any) => p.id === id));
  });
});
