import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  buildVocabularies,
  captureNow,
  closeDb,
  loadState,
  openDb,
  reconcileExtensions,
  withStateTransaction,
  type Agent,
  type Bundle,
  type DiscoveredManifest,
  type GateRole,
  type LLMProvider,
  type Policy,
  type PolicyName,
  type Registry,
  type Stage,
} from "@loomfsm/kernel";

import { createContinueTaskTool, createRunTaskTool } from "../src/index.js";

const FIXED_NOW = "2026-05-28T10:00:00.000Z";

function bundleManifest(name: string): DiscoveredManifest {
  return {
    path: `/fixture/bundle/${name}`,
    raw: {
      manifest_version: "1.0",
      name,
      display_name: name,
      description: "fixture bundle",
      version: "1.0.0",
      kind: "bundle",
      publisher: "@loom",
      capabilities: [],
      requires: { kernel_api: "^3.0.0" },
    },
  };
}

function stubProvider(): LLMProvider {
  return {
    name: "stub",
    capabilities: { execution: "shuttle", idempotent_spawn: true, reports_usage: false },
    async spawn() {
      throw new Error("stub provider spawn must not be called from the transport test");
    },
  };
}

// Two spawn stages — delivering the first agent's result drains its
// pending row, advances the FSM, and the second spawn produces the next
// shuttle directive.
function buildRegistry(): Registry {
  const stages: Record<string, Stage> = {
    "spawn-1": { kind: "spawn", name: "spawn-1", phase: "work", agent: "impl-1" },
    "spawn-2": { kind: "spawn", name: "spawn-2", phase: "work", agent: "impl-2" },
  };
  const agents: Agent[] = [
    { name: "impl-1", template_path: "templates/impl-1.md", output_kind: "nonreview" },
    { name: "impl-2", template_path: "templates/impl-2.md", output_kind: "nonreview" },
  ];
  const bundle: Bundle = {
    name: "code-fixture",
    version: "1.0.0",
    description: "transport test fixture bundle",
    phases: ["work"],
    default_flow: "standard",
    default_gate_policies: {} as Record<GateRole, PolicyName>,
    gate_roles: {},
    agents,
    stages,
    flows: { standard: ["spawn-1", "spawn-2"] },
    hooks: [],
    invariants: [],
  };
  const provider = stubProvider();
  const policyFactories = new Map<PolicyName, () => Policy>();
  policyFactories.set("human", () => () => ({ type: "human-required", reason: "test" }));
  return {
    bundle,
    agents: new Map(agents.map((a) => [a.name, a])),
    stages: new Map(Object.entries(stages)),
    flows: new Map([["standard", ["spawn-1", "spawn-2"]]]),
    hooks: [],
    invariants: [],
    mcp_clients: new Map(),
    providers: {
      resolve: () => provider,
      all: [provider],
      health_check_all: Promise.resolve([{ name: provider.name, healthy: true }]),
    },
    policyFactories,
    vocabularies: buildVocabularies(bundle),
  };
}

interface Harness {
  dir: string;
  allowlistPath: string;
  registry: Registry;
}

async function freshHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "loom-continue-"));
  openDb(dir);
  await reconcileExtensions({
    manifests: [bundleManifest("code-fixture")],
    project_dir: dir,
    now: FIXED_NOW as never,
  });
  const allowlistPath = join(dir, "projects.allow");
  writeFileSync(allowlistPath, `${realpathSync(dir)}\n`, "utf8");
  return { dir, allowlistPath, registry: buildRegistry() };
}

function cleanup(dir: string): void {
  try {
    closeDb(dir);
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
}

function tools(h: Harness) {
  const deps = { resolveRegistry: () => h.registry, allowlistPath: h.allowlistPath };
  return { run: createRunTaskTool(deps), cont: createContinueTaskTool(deps) };
}

// Create the task and return its driver_state_id + the first spawn's
// agent_run_id (the agent the host would execute and report back).
async function bootstrap(h: Harness, uuid: string) {
  const { run } = tools(h);
  const res = await run({ project_dir: h.dir, task: "do work", client_idempotency_uuid: uuid });
  assert.equal(res.response.status, "spawn-agent");
  if (res.response.status !== "spawn-agent") throw new Error("expected spawn-agent");
  return { driver_state_id: res.driver_state_id as string, agent_run_id: res.response.agent_run_id };
}

describe("pipeline_continue_task", () => {
  it("agent-result delivery advances the FSM to the next directive", async () => {
    const h = await freshHarness();
    try {
      const { driver_state_id, agent_run_id } = await bootstrap(h, "uuid-c1");
      const { cont } = tools(h);
      const res = await cont({
        project_dir: h.dir,
        driver_state_id,
        input: { type: "agent-result", agent_run_id, agent_output: "first done" },
      });
      assert.equal(res.response.status, "spawn-agent");
      if (res.response.status === "spawn-agent") {
        assert.equal(res.response.agent, "impl-2");
        assert.notEqual(res.response.agent_run_id, agent_run_id);
      }
    } finally {
      cleanup(h.dir);
    }
  });

  it("agent-result replay returns the identical cached envelope", async () => {
    const h = await freshHarness();
    try {
      const { driver_state_id, agent_run_id } = await bootstrap(h, "uuid-c2");
      const { cont } = tools(h);
      const first = await cont({
        project_dir: h.dir,
        driver_state_id,
        input: { type: "agent-result", agent_run_id, agent_output: "first done" },
      });
      const afterFirst = await withStateTransaction(h.dir, captureNow(), (tx) => loadState(tx));
      const second = await cont({
        project_dir: h.dir,
        driver_state_id,
        input: { type: "agent-result", agent_run_id, agent_output: "first done" },
      });
      const afterReplay = await withStateTransaction(h.dir, captureNow(), (tx) => loadState(tx));

      // Same envelope verbatim, and the replay changed nothing on disk:
      // no extra counter bump, no second step advance, no re-spawn.
      assert.deepEqual(second.response, first.response);
      assert.equal(afterReplay.agents_count, afterFirst.agents_count);
      assert.equal(afterReplay.driver.step_index, afterFirst.driver.step_index);
      assert.equal(afterReplay.pending_agents.length, afterFirst.pending_agents.length);
    } finally {
      cleanup(h.dir);
    }
  });

  it("the recovery variant is refused on this surface", async () => {
    const h = await freshHarness();
    try {
      const { cont } = tools(h);
      const res = await cont({
        project_dir: h.dir,
        driver_state_id: "d-anything",
        input: { type: "recovery", choice: "abandon" },
      });
      assert.equal(res.response.status, "error");
      if (res.response.status === "error") {
        assert.equal(res.response.code, "RECOVERY_VIA_CONTINUE_REFUSED");
      }
    } finally {
      cleanup(h.dir);
    }
  });

  it("a partial fanout batch is refused on this surface", async () => {
    const h = await freshHarness();
    try {
      const { cont } = tools(h);
      const res = await cont({
        project_dir: h.dir,
        driver_state_id: "d-anything",
        input: {
          type: "agents-results",
          results: [{ agent_run_id: "ar-x", agent_output: "partial" }],
          partial: true,
        },
      });
      assert.equal(res.response.status, "error");
      if (res.response.status === "error") {
        assert.equal(res.response.code, "PARTIAL_FANOUT_REFUSED");
      }
    } finally {
      cleanup(h.dir);
    }
  });

  it("a user-answer with no pending gate is refused as stale", async () => {
    const h = await freshHarness();
    try {
      const { driver_state_id } = await bootstrap(h, "uuid-c5");
      const { cont } = tools(h);
      const res = await cont({
        project_dir: h.dir,
        driver_state_id,
        input: {
          type: "user-answer",
          gate_event_id: "gev-00000000-0000-0000-0000-0000000000ff",
          decision: "accept",
        },
      });
      assert.equal(res.response.status, "error");
      if (res.response.status === "error") {
        assert.equal(res.response.code, "GATE_EVENT_STALE");
      }
    } finally {
      cleanup(h.dir);
    }
  });
});

// ============================================================================
// Server-computed file delta (a real git work tree, no mocks)
// ============================================================================

function git(dir: string, ...args: string[]): string {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

function writeFile(dir: string, rel: string, body: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

// Like freshHarness, but the project is a real git repo with a baseline
// commit BEFORE run_task captures the delta baseline. The state DB and the
// allowlist file are ignored so they never leak into the untracked set.
async function freshGitHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "loom-continue-git-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@loom.test");
  git(dir, "config", "user.name", "loom test");
  git(dir, "checkout", "-q", "-b", "main");
  writeFile(dir, ".gitignore", ".claude/\nprojects.allow\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "baseline");

  openDb(dir);
  await reconcileExtensions({
    manifests: [bundleManifest("code-fixture")],
    project_dir: dir,
    now: FIXED_NOW as never,
  });
  const allowlistPath = join(dir, "projects.allow");
  writeFileSync(allowlistPath, `${realpathSync(dir)}\n`, "utf8");
  return { dir, allowlistPath, registry: buildRegistry() };
}

async function loadFiles(dir: string) {
  const state = await withStateTransaction(dir, captureNow(), (tx) => loadState(tx));
  return { modified: state.files_modified, created: state.files_created };
}

describe("pipeline_continue_task — server-computed file delta", () => {
  it("fills files_modified from COMMITTED work the host did not report", async () => {
    const h = await freshGitHarness();
    try {
      const { driver_state_id, agent_run_id } = await bootstrap(h, "uuid-git-1");

      // The implementer commits its work — a working-tree-vs-HEAD diff
      // would now be empty, so the host reports nothing.
      writeFile(h.dir, "src/App.tsx", "export const App = () => null\n");
      git(h.dir, "add", "-A");
      git(h.dir, "commit", "-q", "-m", "implementer work");

      const { cont } = tools(h);
      await cont({
        project_dir: h.dir,
        driver_state_id,
        input: { type: "agent-result", agent_run_id, agent_output: "done" },
      });

      const files = await loadFiles(h.dir);
      assert.deepEqual(
        files.modified,
        ["src/App.tsx"],
        "the server must diff against the task baseline so committed work is recorded",
      );
    } finally {
      cleanup(h.dir);
    }
  });

  it("unions server-computed paths with anything the host reports", async () => {
    const h = await freshGitHarness();
    try {
      const { driver_state_id, agent_run_id } = await bootstrap(h, "uuid-git-2");
      writeFile(h.dir, "src/Committed.tsx", "export const C = () => null\n");
      git(h.dir, "add", "-A");
      git(h.dir, "commit", "-q", "-m", "work");

      const { cont } = tools(h);
      await cont({
        project_dir: h.dir,
        driver_state_id,
        input: {
          type: "agent-result",
          agent_run_id,
          agent_output: "done",
          // A path only the host can see (e.g. outside the repo's view).
          files_modified: ["host/only.ts"],
        },
      });

      const files = await loadFiles(h.dir);
      assert.deepEqual([...files.modified].sort(), ["host/only.ts", "src/Committed.tsx"]);
    } finally {
      cleanup(h.dir);
    }
  });

  it("degrades gracefully on a non-git project — host accounting still stands", async () => {
    const h = await freshHarness();
    try {
      const { driver_state_id, agent_run_id } = await bootstrap(h, "uuid-git-3");
      const { cont } = tools(h);
      await cont({
        project_dir: h.dir,
        driver_state_id,
        input: {
          type: "agent-result",
          agent_run_id,
          agent_output: "done",
          files_modified: ["host/reported.ts"],
        },
      });
      const files = await loadFiles(h.dir);
      // No baseline was stored (not a git repo) → the server adds nothing,
      // does not throw, and the host's reported set is preserved verbatim.
      assert.deepEqual(files.modified, ["host/reported.ts"]);
    } finally {
      cleanup(h.dir);
    }
  });
});
