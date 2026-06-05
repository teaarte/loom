// The per-spawn transcript read route — `GET /projects/:id/spawn/:run_id`. It
// serves the sidecar the driver wrote at the HOST project (NOT the sandbox), so
// an operator can read WHAT a spawn produced at the gate / in the chain. Over a
// REAL server + a REAL on-disk sidecar (written by the driver's own writer); the
// traversal guard is exercised end to end.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import { spawnTranscriptDir, spawnTranscriptPath, writeSpawnTranscript } from "@loomfsm/driver";

import { startControlPlane, type ControlPlaneHandle } from "../src/index.js";
import { cleanup, freshProject, makeDashboardFixture, recordingExecutor, spawnRegistry, tempStateDir } from "./fixtures.js";
import type { Registry } from "@loomfsm/kernel";

const TOKEN = "dev-token";

const registries = new Map<string, Registry>();
function resolveRegistry(dir: string): Registry {
  return registries.get(dir) ?? registries.get(resolve(dir)) ?? spawnRegistry();
}

let handle: ControlPlaneHandle;
let base: string;
const controller = new AbortController();
const dirs: string[] = [];
const stateDir = tempStateDir();
const loomHome = mkdtempSync(join(tmpdir(), "loom-spawn-home-"));

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
    watch_idle_ms: 15,
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
async function req(method: string, path: string): Promise<Resp> {
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}` } });
  const text = await res.text();
  return { status: res.status, json: text.length > 0 ? JSON.parse(text) : null };
}

async function register(): Promise<string> {
  const dir = await freshProject("loom-spawn-");
  dirs.push(dir);
  registries.set(dir, spawnRegistry());
  const res = await fetch(base + "/projects", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ dir }),
  });
  return ((await res.json()) as { id: string }).id;
}

describe("GET /projects/:id/spawn/:run_id — transcript sidecar", () => {
  it("returns the transcript the driver wrote, verbatim", async () => {
    const id = await register();
    const dir = dirs[dirs.length - 1] as string;
    writeSpawnTranscript(dir, {
      agent: "implementer",
      agent_run_id: "ar-abc123",
      phase: "implementation",
      model: "opus",
      prompt: "do the thing",
      raw_output: "did the thing",
      parse_result: { files_modified: ["src/x.ts"] },
      usage: { agent: "implementer", model: "opus", tokens: { in: 10, out: 20 }, cost_usd: 0.01 },
      recorded_at: "2026-06-05T00:00:00.000Z",
    });

    const res = await req("GET", `/projects/${encodeURIComponent(id)}/spawn/ar-abc123`);
    assert.equal(res.status, 200);
    assert.equal(res.json.run_id, "ar-abc123");
    assert.equal(res.json.transcript.agent, "implementer");
    assert.equal(res.json.transcript.prompt, "do the thing");
    assert.equal(res.json.transcript.raw_output, "did the thing");
    assert.deepEqual(res.json.transcript.parse_result.files_modified, ["src/x.ts"]);
    assert.equal(res.json.transcript.usage.cost_usd, 0.01);
  });

  it("404s an unknown run id (no sidecar on disk)", async () => {
    const id = await register();
    // Touch the dir so the transcripts dir exists but lacks the requested id.
    writeSpawnTranscript(dirs[dirs.length - 1] as string, {
      agent: "a", agent_run_id: "ar-present", phase: "p", model: null,
      prompt: "", raw_output: "", parse_result: {}, recorded_at: "2026-06-05T00:00:00.000Z",
    });
    const res = await req("GET", `/projects/${encodeURIComponent(id)}/spawn/ar-missing`);
    assert.equal(res.status, 404);
    assert.equal(res.json.error.code, "TRANSCRIPT_NOT_FOUND");
  });

  it("refuses a traversal-shaped run id (400, never escapes the sidecar dir)", async () => {
    const id = await register();
    writeSpawnTranscript(dirs[dirs.length - 1] as string, {
      agent: "a", agent_run_id: "ar-x", phase: "p", model: null,
      prompt: "", raw_output: "", parse_result: {}, recorded_at: "2026-06-05T00:00:00.000Z",
    });
    // %2f keeps the dot-dot in a single path segment; the safe-id regex (which
    // forbids `%` and separators) rejects it before any path join.
    const res = await req("GET", `/projects/${encodeURIComponent(id)}/spawn/..%2f..%2f..%2fetc%2fpasswd`);
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, "BAD_RUN_ID");
  });

  it("writes a self-ignoring .gitignore into the transcripts dir", async () => {
    const dir = await freshProject("loom-spawn-gi-");
    dirs.push(dir);
    writeSpawnTranscript(dir, {
      agent: "a", agent_run_id: "ar-1", phase: "p", model: null,
      prompt: "", raw_output: "", parse_result: {}, recorded_at: "2026-06-05T00:00:00.000Z",
    });
    const { readFileSync } = await import("node:fs");
    assert.equal(readFileSync(join(spawnTranscriptDir(dir), ".gitignore"), "utf8"), "*\n");
    // The path helper is the same one the route resolves.
    assert.ok(spawnTranscriptPath(dir, "ar-1").endsWith(join("transcripts", "ar-1.json")));
  });
});
