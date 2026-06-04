// The HTTP transport end to end, over a REAL server (loopback, ephemeral port)
// + REAL stores, with the backend stubbed. Proves the network surface the
// dashboard / a bot / a poller all use: auth, register, submit → drive →
// complete, submit → park → answer → complete, and two projects in parallel
// without crossing stores. No mocked DB, no `claude -p`.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import { startControlPlane, type ControlPlaneHandle } from "../src/index.js";
import {
  cleanup,
  freshProject,
  gateRegistry,
  makeDashboardFixture,
  recordingExecutor,
  spawnRegistry,
  tempStateDir,
} from "./fixtures.js";
import type { Registry } from "@loomfsm/kernel";

const TOKEN = "dev-token";
const FAST = { watch_idle_ms: 15, wake: { poll_base_ms: 15, poll_factor: 1, poll_ceiling_ms: 40 } };

// A per-dir registry dispatcher so different projects can run different flows.
const registries = new Map<string, Registry>();
function resolveRegistry(dir: string): Registry {
  return registries.get(dir) ?? registries.get(resolve(dir)) ?? spawnRegistry();
}

let handle: ControlPlaneHandle;
let base: string;
const controller = new AbortController();
const dirs: string[] = [];
const stateDir = tempStateDir();
const loomHome = mkdtempSync(join(tmpdir(), "loom-server-home-"));

before(async () => {
  handle = await startControlPlane({
    stateDir,
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    resolveRegistry,
    buildExecutor: () => recordingExecutor([]),
    dashboardDir: makeDashboardFixture(),
    loomHome,
    signal: controller.signal,
    ...FAST,
  });
  base = `http://127.0.0.1:${handle.port}`;
});

after(async () => {
  controller.abort();
  await handle.closed;
  for (const d of dirs) cleanup(d);
  rmSync(loomHome, { recursive: true, force: true });
});

interface Resp {
  status: number;
  json: any;
}
async function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<Resp> {
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
    /* non-JSON (the dashboard) */
  }
  return { status: res.status, json };
}

async function until<T>(fn: () => Promise<T | null | undefined | false>, label: string): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function registerProject(flow: "spawn" | "gate"): Promise<string> {
  const dir = await freshProject(`loom-server-${flow}-`);
  dirs.push(dir);
  registries.set(dir, flow === "gate" ? gateRegistry() : spawnRegistry());
  const res = await req("POST", "/projects", { token: TOKEN, body: { dir } });
  assert.equal(res.status, 201);
  return res.json.id as string;
}

describe("http — health + auth", () => {
  it("serves /health without a token", async () => {
    const res = await req("GET", "/health");
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  });

  it("rejects an API call without the bearer token (401)", async () => {
    const res = await req("GET", "/projects");
    assert.equal(res.status, 401);
    assert.equal(res.json.error.code, "UNAUTHORIZED");
  });

  it("serves the dashboard SPA shell at / without a token", async () => {
    const res = await fetch(base + "/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /loom control plane/);
    assert.match(html, /<div id="root">/);
  });

  it("serves a hashed asset (immutable) without a token", async () => {
    const res = await fetch(base + "/assets/app.js");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
    assert.match(res.headers.get("cache-control") ?? "", /immutable/);
  });
});

describe("http — submit drives a task to complete", () => {
  it("POST /submit → watcher drives the spawn flow → GET /projects/:id is completed", async () => {
    const id = await registerProject("spawn");
    const sub = await req("POST", "/submit", { token: TOKEN, body: { project: id, task: "ship it" } });
    assert.equal(sub.status, 200);
    assert.ok(sub.json.task_id);

    const done = await until(async () => {
      const r = await req("GET", `/projects/${id}`, { token: TOKEN });
      return r.json?.status?.status === "completed" ? r.json : null;
    }, "spawn task to complete");
    assert.equal(done.status.status, "completed");
    assert.equal(done.status.verdict, "accepted");
  });

  it("rejects an empty task with a typed 400", async () => {
    const id = await registerProject("spawn");
    const res = await req("POST", "/submit", { token: TOKEN, body: { project: id, task: "" } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, "TASK_REQUIRED");
  });
});

describe("http — submit adopts a cataloged-but-unsupervised project", () => {
  // The dashboard's add-project writes the durable catalog (`/workspace/projects`),
  // which is distinct from the live supervised set the watcher loop re-attaches.
  // Submitting by such a catalog id used to 404 ("not registered and is not a
  // directory"); now submit adopts it — registers + supervises — and drives it.
  it("POST /submit by a catalog id supervises it and drives to complete", async () => {
    const dir = await freshProject("loom-server-catalog-");
    dirs.push(dir);
    registries.set(dir, spawnRegistry());

    // Catalog only — NOT POST /projects, so it is not in the live registry.
    const add = await req("POST", "/workspace/projects", { token: TOKEN, body: { dir } });
    assert.equal(add.status, 201);
    const id = add.json.id as string;

    const before = await req("GET", "/projects", { token: TOKEN });
    assert.ok(!before.json.some((p: any) => p.id === id), "project is not supervised before submit");

    // The regression: a submit by the catalog id resolves (used to be 404).
    const sub = await req("POST", "/submit", { token: TOKEN, body: { project: id, task: "ship it" } });
    assert.equal(sub.status, 200, JSON.stringify(sub.json));
    assert.equal(sub.json.id, id);

    const after = await req("GET", "/projects", { token: TOKEN });
    assert.ok(after.json.some((p: any) => p.id === id), "submit adopted the project into the supervised set");

    const done = await until(async () => {
      const r = await req("GET", `/projects/${id}`, { token: TOKEN });
      return r.json?.status?.status === "completed" ? r.json : null;
    }, "cataloged submit to complete");
    assert.equal(done.status.verdict, "accepted");
  });

  it("GET /projects/:id + /log resolve a cataloged project before any submit", async () => {
    const dir = await freshProject("loom-server-catalog-read-");
    dirs.push(dir);
    registries.set(dir, spawnRegistry());
    const add = await req("POST", "/workspace/projects", { token: TOKEN, body: { dir } });
    const id = add.json.id as string;

    // Read-only detail works without supervising (status is the empty "no task").
    const detail = await req("GET", `/projects/${id}`, { token: TOKEN });
    assert.equal(detail.status, 200);
    assert.equal(detail.json.id, id);
    assert.equal(detail.json.status.has_task, false);

    // …and it did NOT get supervised just by being read.
    const list = await req("GET", "/projects", { token: TOKEN });
    assert.ok(!list.json.some((p: any) => p.id === id), "a read must not start a watcher");
  });
});

describe("http — submit, park, answer, complete", () => {
  it("parks on a human gate, then a POST /answer wakes it to complete", async () => {
    const id = await registerProject("gate");
    const sub = await req("POST", "/submit", { token: TOKEN, body: { project: id, task: "needs sign-off" } });
    assert.equal(sub.status, 200);

    const parked = await until(async () => {
      const r = await req("GET", `/projects/${id}`, { token: TOKEN });
      return r.json?.status?.parked_gate ? r.json.status.parked_gate : null;
    }, "task to park on the gate");

    const ans = await req("POST", `/projects/${id}/answer`, {
      token: TOKEN,
      body: { gate_event_id: parked.gate_event_id, decision: "accept" },
    });
    assert.equal(ans.status, 200);

    const done = await until(async () => {
      const r = await req("GET", `/projects/${id}`, { token: TOKEN });
      return r.json?.status?.status === "completed" ? r.json : null;
    }, "answered task to complete");
    assert.equal(done.status.status, "completed");
  });
});

describe("http — two projects in parallel through the registry", () => {
  it("drives both without crossing stores", async () => {
    const a = await registerProject("spawn");
    const b = await registerProject("spawn");
    assert.notEqual(a, b);

    await req("POST", "/submit", { token: TOKEN, body: { project: a, task: "task A" } });
    await req("POST", "/submit", { token: TOKEN, body: { project: b, task: "task B" } });

    const both = await until(async () => {
      const list = await req("GET", "/projects", { token: TOKEN });
      const rows: any[] = list.json ?? [];
      const ra = rows.find((r) => r.id === a);
      const rb = rows.find((r) => r.id === b);
      return ra?.status?.status === "completed" && rb?.status?.status === "completed" ? { ra, rb } : null;
    }, "both projects to complete");

    assert.notEqual(both.ra.status.task_id, both.rb.status.task_id);
    assert.equal(both.ra.status.task_label, "task A");
    assert.equal(both.rb.status.task_label, "task B");
  });

  it("404s an unknown project id", async () => {
    const res = await req("GET", "/projects/deadbeef0000", { token: TOKEN });
    assert.equal(res.status, 404);
    assert.equal(res.json.error.code, "PROJECT_NOT_FOUND");
  });
});
