import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
} from "@loom/kernel";

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
