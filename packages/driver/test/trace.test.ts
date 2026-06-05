// `readTrace` / `readTraceFile` — the domain-blind agent-chain reader — against
// a REAL SQLite store. No mocked DB: a spawn flow is driven to completion over a
// fabricated roster, then the chain is read back from the live store and from a
// byte-copy of it (the archived-store path). Proves the reader surfaces whatever
// names a roster carries, in order, and that a read on a store-less project is
// the empty trace WITHOUT creating a store.

import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  buildVocabularies,
  closeDb,
  openDb,
  reconcileExtensions,
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

import { drive, readTrace, readTraceFile, type Executor } from "../src/index.js";

const FIXED_NOW = "2026-06-02T10:00:00.000Z";

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
      throw new Error("the injected executor runs spawns");
    },
  };
}

// A two-spawn flow over a FABRICATED pair of agent names — the genericity vehicle
// at the driver layer: the reader must echo whatever names the roster declares.
function twoSpawnRegistry(agentA: string, agentB: string): Registry {
  const stages: Record<string, Stage> = {
    "spawn-1": { kind: "spawn", name: "spawn-1", phase: "work", agent: agentA },
    "spawn-2": { kind: "spawn", name: "spawn-2", phase: "work", agent: agentB },
    "finalize-1": { kind: "finalize", name: "finalize-1" },
  };
  const agents: Agent[] = [
    { name: agentA, template_path: `templates/${agentA}.md`, output_kind: "nonreview" },
    { name: agentB, template_path: `templates/${agentB}.md`, output_kind: "nonreview" },
  ];
  const flow = ["spawn-1", "spawn-2", "finalize-1"];
  const bundle: Bundle = {
    name: "code-fixture",
    version: "1.0.0",
    description: "driver trace fixture bundle",
    phases: ["work"],
    default_flow: "standard",
    default_gate_policies: {} as Record<GateRole, PolicyName>,
    gate_roles: {},
    agents,
    stages,
    flows: { standard: flow },
    hooks: [],
    invariants: [],
  };
  const policyFactories = new Map<PolicyName, () => Policy>();
  policyFactories.set("human", () => () => ({ type: "human-required", reason: "test" }));
  return {
    bundle,
    agents: new Map(agents.map((a) => [a.name, a])),
    stages: new Map(Object.entries(stages)),
    flows: new Map([["standard", flow]]),
    hooks: [],
    invariants: [],
    mcp_clients: new Map(),
    providers: {
      resolve: () => stubProvider(),
      all: [stubProvider()],
      health_check_all: Promise.resolve([{ name: "stub", healthy: true }]),
    },
    policyFactories,
    vocabularies: buildVocabularies(bundle),
  };
}

async function freshProject(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "loom-trace-"));
  openDb(dir);
  await reconcileExtensions({
    manifests: [bundleManifest("code-fixture")],
    project_dir: dir,
    now: FIXED_NOW as never,
  });
  return dir;
}

function cleanup(dir: string): void {
  try {
    closeDb(dir);
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
}

const echoExecutor: Executor = { execute: async (s) => ({ agent_output: `done ${s.agent}` }) };

describe("readTrace — live store", () => {
  it("returns the ordered chain over a fabricated roster", async () => {
    const dir = await freshProject();
    try {
      const outcome = await drive(dir, {
        executor: echoExecutor,
        resolveRegistry: () => twoSpawnRegistry("scout-x", "weave-y"),
        task: "trace the chain",
        client_idempotency_uuid: "cidem-trace",
      });
      assert.equal(outcome.kind, "complete");

      const trace = await readTrace(dir);
      assert.ok(trace.summary);
      assert.equal(trace.summary?.status, "completed");
      assert.deepEqual(trace.agents.map((a) => a.agent), ["scout-x", "weave-y"]);
      // Each run carries its generic columns — a persist stamp + output kind.
      assert.ok(trace.agents.every((a) => a.recorded_at.length > 0));
      assert.equal(trace.agents[0]?.output_kind, "nonreview");
    } finally {
      cleanup(dir);
    }
  });
});

describe("readTraceFile — an archived store byte-copy", () => {
  it("reads the same chain from a copied .db with the same reader", async () => {
    const dir = await freshProject();
    let copy = "";
    try {
      await drive(dir, {
        executor: echoExecutor,
        resolveRegistry: () => twoSpawnRegistry("scout-x", "weave-y"),
        task: "archive me",
        client_idempotency_uuid: "cidem-archive",
      });
      // Checkpoint the WAL into the main file (close the pool), then byte-copy —
      // the same copy → verify the archival path performs.
      closeDb(dir);
      const live = join(dir, ".claude", "state.db");
      copy = join(mkdtempSync(join(tmpdir(), "loom-trace-archive-")), "task.db");
      copyFileSync(live, copy);

      const trace = await readTraceFile(copy);
      assert.equal(trace.summary?.status, "completed");
      assert.deepEqual(trace.agents.map((a) => a.agent), ["scout-x", "weave-y"]);
    } finally {
      if (copy.length > 0) rmSync(join(copy, ".."), { recursive: true, force: true });
      cleanup(dir);
    }
  });
});

describe("readTrace — completion summary surfacing", () => {
  it("surfaces a kernel-generic bundle_state.completion_summary on the trace summary", async () => {
    const dir = await freshProject();
    let copy = "";
    try {
      await drive(dir, {
        executor: echoExecutor,
        resolveRegistry: () => twoSpawnRegistry("scout-x", "weave-y"),
        task: "summarize me",
        client_idempotency_uuid: "cidem-summary",
      });
      // Stand in for the bundle's finish-summary step: write the generic note the
      // kernel appends at finalize directly into the stored bundle_state. The
      // reader must surface it (and ignore everything else in bundle_state).
      closeDb(dir);
      const live = join(dir, ".claude", "state.db");
      const db = new DatabaseSync(live);
      db.exec(
        `UPDATE pipeline_state SET bundle_state = '${JSON.stringify({
          completion_summary: "Touched 2 changed file(s). (complexity simple)",
          some_other_field: { nested: true },
        }).replace(/'/g, "''")}' WHERE id = 1`,
      );
      db.close();
      copy = join(mkdtempSync(join(tmpdir(), "loom-trace-sum-")), "task.db");
      copyFileSync(live, copy);

      const trace = await readTraceFile(copy);
      assert.equal(trace.summary?.completion_summary, "Touched 2 changed file(s). (complexity simple)");
    } finally {
      if (copy.length > 0) rmSync(join(copy, ".."), { recursive: true, force: true });
      cleanup(dir);
    }
  });

  it("is null when no completion note was written", async () => {
    const dir = await freshProject();
    try {
      await drive(dir, {
        executor: echoExecutor,
        resolveRegistry: () => twoSpawnRegistry("scout-x", "weave-y"),
        task: "no summary",
        client_idempotency_uuid: "cidem-nosum",
      });
      const trace = await readTrace(dir);
      assert.equal(trace.summary?.completion_summary, null);
    } finally {
      cleanup(dir);
    }
  });
});

describe("readTrace — store-less project", () => {
  it("is the empty trace and does NOT create a store on a read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-trace-none-"));
    try {
      const trace = await readTrace(dir);
      assert.equal(trace.summary, null);
      assert.deepEqual(trace.agents, []);
      // A mere read must not materialize a store (no openDb side effect).
      assert.equal(existsSync(join(dir, ".claude", "state.db")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
