// The ship routes — POST /projects/:id/push and /merge — over a REAL server.
// They wrap the daemon's git helpers (whose refusals are unit-tested on real
// repos); here we prove the HTTP wiring: a completed task on a NON-git project
// refuses cleanly with a 200 + typed reason (an outcome, not a server error),
// an empty slot is a 400, and an unknown project is a 404.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import { startControlPlane, type ControlPlaneHandle } from "../src/index.js";
import { cleanup, freshProject, makeDashboardFixture, recordingExecutor, spawnRegistry, tempStateDir } from "./fixtures.js";
import type { Registry } from "@loomfsm/kernel";

const TOKEN = "dev-token";
const FAST = { watch_idle_ms: 15, wake: { poll_base_ms: 15, poll_factor: 1, poll_ceiling_ms: 40 } };

const registries = new Map<string, Registry>();
function resolveRegistry(dir: string): Registry {
  return registries.get(dir) ?? registries.get(resolve(dir)) ?? spawnRegistry();
}

let handle: ControlPlaneHandle;
let base: string;
const controller = new AbortController();
const dirs: string[] = [];
const stateDir = tempStateDir();
const loomHome = mkdtempSync(join(tmpdir(), "loom-ship-home-"));

before(async () => {
  handle = await startControlPlane({
    stateDir, host: "127.0.0.1", port: 0, token: TOKEN,
    resolveRegistry,
    buildExecutor: () => recordingExecutor([]),
    dashboardDir: makeDashboardFixture(),
    loomHome, signal: controller.signal, ...FAST,
  });
  base = `http://127.0.0.1:${handle.port}`;
});

after(async () => {
  controller.abort();
  await handle.closed;
  for (const d of dirs) cleanup(d);
  rmSync(loomHome, { recursive: true, force: true });
});

interface Resp { status: number; json: any }
async function req(method: string, path: string, body?: unknown): Promise<Resp> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(base + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, json: text.length > 0 ? JSON.parse(text) : null };
}
async function until<T>(fn: () => Promise<T | null>, label: string): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("ship routes — push / merge", () => {
  it("404s an unknown project", async () => {
    const r = await req("POST", "/projects/deadbeef/push");
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, "PROJECT_NOT_FOUND");
  });

  it("400s when the slot is empty (no task to ship)", async () => {
    const dir = await freshProject("loom-ship-empty-");
    dirs.push(dir);
    registries.set(dir, spawnRegistry());
    const add = await req("POST", "/projects", { dir });
    const id = add.json.id as string;
    const r = await req("POST", `/projects/${id}/merge`);
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, "NO_TASK");
  });

  it("refuses cleanly (200 + reason) on a non-git completed task", async () => {
    const dir = await freshProject("loom-ship-nogit-");
    dirs.push(dir);
    registries.set(dir, spawnRegistry());
    const add = await req("POST", "/projects", { dir });
    const id = add.json.id as string;
    await req("POST", "/submit", { project: id, task: "ship it" });
    await until(async () => {
      const r = await req("GET", `/projects/${id}`);
      return r.json?.status?.status === "completed" ? r.json : null;
    }, "task to complete");

    const push = await req("POST", `/projects/${id}/push`);
    assert.equal(push.status, 200);
    assert.equal(push.json.pushed, false);
    assert.equal(push.json.reason, "no-git");

    const merge = await req("POST", `/projects/${id}/merge`);
    assert.equal(merge.status, 200);
    assert.equal(merge.json.merged, false);
    assert.equal(merge.json.reason, "no-git");
  });
});
