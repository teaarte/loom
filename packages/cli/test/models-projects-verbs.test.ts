// `loom models` + `loom projects` verbs — driven against a temp global home with
// the roster / id / status seams injected, so they need no bundle load and no
// store. The `models` roster is a FABRICATED non-code roster: the verb resolving
// it with zero code-bundle assumption is the genericity check at the CLI layer.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { readGlobalConfig, writeGlobalConfig, type BundleRoster } from "@loomfsm/config";

import { models } from "../src/commands/models.js";
import { projects } from "../src/commands/projects.js";
import type { CliEnv } from "../src/lib/env.js";

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "loom-cli-mp-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function capture(cwd = "/unused"): { env: CliEnv; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const env: CliEnv = { home: "/unused", cwd, out: (l) => out.push(l), err: (l) => err.push(l) };
  return { env, out, err };
}

// A roster matching NO real bundle — proves `loom models` binds whatever roster
// it is handed.
const roster: BundleRoster = {
  name: "atlas",
  agents: [
    { name: "scout", default_model: "cheap" },
    { name: "oracle", default_model: "deep" },
  ],
  default_model_tiers: { cheap: "model-cheap", deep: "model-deep" },
  default_provider: "claude-code-shuttle",
};

describe("loom models", () => {
  it("sets an agent's model into the bundle-namespaced map", async () => {
    const home = tmp();
    const { env, out } = capture();
    assert.equal(await models(["set", "oracle", "anthropic:big-model"], env, { loomHome: home, roster }), 0);
    assert.equal(readGlobalConfig(home).bundles?.["atlas"]?.agents?.["oracle"], "anthropic:big-model");
    assert.ok(out.some((l) => l.includes("atlas/oracle")));
  });

  it("rejects an agent not in the roster", async () => {
    const home = tmp();
    const { env, err } = capture();
    assert.equal(await models(["set", "nonesuch", "x"], env, { loomHome: home, roster }), 1);
    assert.ok(err.some((l) => l.includes("not an agent of bundle 'atlas'")));
  });

  it("rejects an incompatible (backend, model) pair at entry", async () => {
    const home = tmp();
    // Pin the backend to codex (OpenAI-only) in the global config first.
    writeGlobalConfig(home, { backend: "codex" });
    const { env, err } = capture();
    assert.equal(await models(["set", "scout", "google:gemini-x"], env, { loomHome: home, roster }), 1);
    assert.ok(err.some((l) => l.includes("codex") && l.includes("google")));
    // Nothing was written.
    assert.equal(readGlobalConfig(home).bundles, undefined);
  });

  it("lists overrides and bundle defaults", async () => {
    const home = tmp();
    await models(["set", "scout", "deep"], capture().env, { loomHome: home, roster });
    const { env, out } = capture();
    assert.equal(await models(["list"], env, { loomHome: home, roster }), 0);
    const text = out.join("\n");
    assert.ok(/scout.*deep.*model-deep.*override/s.test(text) || text.includes("scout = deep"));
    assert.ok(text.includes("oracle") && text.includes("bundle default"));
  });
});

describe("loom projects", () => {
  const fakeId = (dir: string): string => `id-${dir.split("/").pop() ?? "x"}`;
  const fakeStatus = async (
    dir: string,
  ): Promise<import("@loomfsm/server").ProjectStatusView> => ({
    project_dir: dir,
    has_task: false,
    task_id: null,
    task_label: null,
    status: null,
    verdict: null,
    flow: null,
    active_phase: null,
    parked_gate: null,
    pending_agents: [],
    stalled: false,
  });

  it("adds, lists with status, and removes", async () => {
    const home = tmp();
    const add = capture();
    assert.equal(
      await projects(["add", "/proj/alpha", "--label", "Alpha"], add.env, {
        loomHome: home,
        projectId: fakeId,
        nowIso: "2026-06-03T00:00:00.000Z",
      }),
      0,
    );
    assert.ok(add.out.some((l) => l.includes("id-alpha") && l.includes("Alpha")));

    const list = capture();
    assert.equal(
      await projects(["list"], list.env, { loomHome: home, readStatus: fakeStatus, now: 0 }),
      0,
    );
    const text = list.out.join("\n");
    assert.ok(text.includes("id-alpha"));
    assert.ok(text.includes("no active task"));

    const rm = capture();
    assert.equal(await projects(["remove", "id-alpha"], rm.env, { loomHome: home, projectId: fakeId }), 0);
    assert.ok(rm.out.some((l) => l.includes("removed id-alpha")));
  });

  it("removes by path too", async () => {
    const home = tmp();
    await projects(["add", "/proj/beta"], capture().env, { loomHome: home, projectId: fakeId, nowIso: "T" });
    const rm = capture();
    assert.equal(await projects(["remove", "/proj/beta"], rm.env, { loomHome: home, projectId: fakeId }), 0);
    assert.ok(rm.out.some((l) => l.includes("removed id-beta")));
  });

  it("reports an empty catalog", async () => {
    const home = tmp();
    const { env, out } = capture();
    assert.equal(await projects(["list"], env, { loomHome: home, readStatus: fakeStatus }), 0);
    assert.ok(out.some((l) => l.includes("catalog is empty")));
  });
});
