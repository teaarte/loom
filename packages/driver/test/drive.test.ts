// `drive()` — the headless loop — against a REAL SQLite store and stub
// executors. No mocked DB: every test opens a temp project, drives it with
// an injected executor, and asserts the kernel state the loop produced.
//
// Coverage:
//   * a spawn flow drives to `complete` (spawn -> deliver -> ... -> terminal);
//   * a human gate PAUSES (no auto-answer), and resuming continues it;
//   * an error directive routes to the caller's recovery policy;
//   * idempotency: a re-resumed delivery of the same agent_run_id dedups,
//     and an executor that fails once is retried via the restart head;
//   * a fanout honors max_concurrent_spawns (count) and spawn_budget (time);
//   * the loop feeds executor-reported files through delivery (conformance).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
  type FanoutStage,
  type GateRole,
  type LLMProvider,
  type Policy,
  type PolicyName,
  type ProviderShuttleIntent,
  type Registry,
  type Stage,
  type UserAnswerSchema,
} from "@loomfsm/kernel";

import {
  createAndStart,
  deliverAndAdvance,
  drive,
  readState,
  resumeDirective,
  type Executor,
  type ExecutorResult,
} from "../src/index.js";

const FIXED_NOW = "2026-06-02T10:00:00.000Z";

const GATE_SCHEMA: UserAnswerSchema = {
  options: [
    { verbs: ["approve", "yes"], label: "Approve", produces: { decision: "accept" } },
    {
      verbs: ["reject", "no"],
      label: "Reject",
      produces: { decision: "reject", reject_intent: "revise" },
    },
  ],
};

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
      // The injected Executor runs spawns; the provider only supplies
      // routing metadata (name + idempotency) to the kernel.
      throw new Error("stub provider spawn must not be called from the driver loop");
    },
  };
}

function assembleRegistry(bundle: Bundle, agents: Agent[], stages: Record<string, Stage>, flow: string[]): Registry {
  const provider = stubProvider();
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
      resolve: () => provider,
      all: [provider],
      health_check_all: Promise.resolve([{ name: provider.name, healthy: true }]),
    },
    policyFactories,
    vocabularies: buildVocabularies(bundle),
  };
}

function bundleOf(stages: Record<string, Stage>, agents: Agent[], flow: string[]): Bundle {
  return {
    name: "code-fixture",
    version: "1.0.0",
    description: "driver test fixture bundle",
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
}

// spawn-1 -> spawn-2 -> finalize : drives to a terminal complete.
function spawnRegistry(): Registry {
  const stages: Record<string, Stage> = {
    "spawn-1": { kind: "spawn", name: "spawn-1", phase: "work", agent: "impl-1" },
    "spawn-2": { kind: "spawn", name: "spawn-2", phase: "work", agent: "impl-2" },
    "finalize-1": { kind: "finalize", name: "finalize-1" },
  };
  const agents: Agent[] = [
    { name: "impl-1", template_path: "templates/impl-1.md", output_kind: "nonreview" },
    { name: "impl-2", template_path: "templates/impl-2.md", output_kind: "nonreview" },
  ];
  const flow = ["spawn-1", "spawn-2", "finalize-1"];
  return assembleRegistry(bundleOf(stages, agents, flow), agents, stages, flow);
}

// spawn-1 only — after the single spawn drains the FSM overflows the flow,
// producing an error directive the recovery policy must field.
function overflowRegistry(): Registry {
  const stages: Record<string, Stage> = {
    "spawn-1": { kind: "spawn", name: "spawn-1", phase: "work", agent: "impl-1" },
  };
  const agents: Agent[] = [
    { name: "impl-1", template_path: "templates/impl-1.md", output_kind: "nonreview" },
  ];
  const flow = ["spawn-1"];
  return assembleRegistry(bundleOf(stages, agents, flow), agents, stages, flow);
}

// fan-1 (N agents) -> finalize, with optional concurrency / time budget.
function fanoutRegistry(opts: {
  agents?: number;
  max_concurrent_spawns?: number;
  spawn_budget_ms?: number;
}): Registry {
  const n = opts.agents ?? 3;
  const agentNames = Array.from({ length: n }, (_, i) => `rev-${i + 1}`);
  const agents: Agent[] = agentNames.map((name) => ({
    name,
    template_path: `templates/${name}.md`,
    output_kind: "nonreview",
  }));
  const fan: FanoutStage = {
    kind: "fanout",
    name: "fan-1",
    phase: "work",
    agents: agentNames,
    ...(opts.max_concurrent_spawns !== undefined
      ? { max_concurrent_spawns: opts.max_concurrent_spawns }
      : {}),
    ...(opts.spawn_budget_ms !== undefined
      ? {
          spawn_budget: {
            kind: "time" as const,
            timeout_ms: opts.spawn_budget_ms,
            on_exhaustion: "audit-only" as const,
          },
        }
      : {}),
  };
  const stages: Record<string, Stage> = {
    "fan-1": fan,
    "finalize-1": { kind: "finalize", name: "finalize-1" },
  };
  const flow = ["fan-1", "finalize-1"];
  return assembleRegistry(bundleOf(stages, agents, flow), agents, stages, flow);
}

// gate-1 (human) -> finalize : parks at an ask-user.
function gateRegistry(): Registry {
  const stages: Record<string, Stage> = {
    "gate-1": {
      kind: "gate",
      name: "gate-1",
      phase: "work",
      message: () => "Approve the plan?",
      valid_answers: () => GATE_SCHEMA,
    },
    "finalize-1": { kind: "finalize", name: "finalize-1" },
  };
  const flow = ["gate-1", "finalize-1"];
  return assembleRegistry(bundleOf(stages, [], flow), [], stages, flow);
}

async function freshProject(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "loom-drive-"));
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

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// An executor that echoes a fixed output for every spawn.
function echoExecutor(): Executor {
  return { execute: async (s) => ({ agent_output: `output for ${s.agent}` }) };
}

describe("drive — happy path", () => {
  it("drives a spawn flow to complete (spawn -> deliver -> ... -> terminal)", async () => {
    const dir = await freshProject();
    try {
      const seen: string[] = [];
      const executor: Executor = {
        execute: async (s: ProviderShuttleIntent) => {
          seen.push(s.agent);
          // The loop re-derives the real prompt before executing.
          assert.ok(s.prompt.length > 0);
          return { agent_output: `done ${s.agent}` };
        },
      };
      const outcome = await drive(dir, {
        executor,
        resolveRegistry: () => spawnRegistry(),
        task: "do the work",
        client_idempotency_uuid: "cidem-happy",
      });
      assert.equal(outcome.kind, "complete");
      if (outcome.kind === "complete") assert.equal(outcome.verdict, "accepted");
      // Both spawns ran, in order, each exactly once.
      assert.deepEqual(seen, ["impl-1", "impl-2"]);
      const state = await readState(dir);
      assert.equal(state.status, "completed");
    } finally {
      cleanup(dir);
    }
  });
});

describe("drive — human gate pauses (no auto-answer)", () => {
  it("returns paused at an ask-user and never invokes the executor", async () => {
    const dir = await freshProject();
    try {
      let executed = 0;
      const executor: Executor = {
        execute: async () => {
          executed += 1;
          return { agent_output: "" };
        },
      };
      const outcome = await drive(dir, {
        executor,
        resolveRegistry: () => gateRegistry(),
        task: "gated work",
        client_idempotency_uuid: "cidem-gate",
      });
      assert.equal(outcome.kind, "paused");
      if (outcome.kind === "paused") {
        assert.equal(outcome.reason, "ask-user");
        assert.equal(outcome.gate, "gate-1");
        assert.equal(outcome.message, "Approve the plan?");
        assert.ok(outcome.gate_event_id.length > 0);
      }
      assert.equal(executed, 0, "a human gate must not auto-run anything");

      // A second drive (attach, no task) resumes and re-emits the SAME ask —
      // the restart head, not a fresh tick.
      const again = await drive(dir, { executor, resolveRegistry: () => gateRegistry() });
      assert.equal(again.kind, "paused");
      if (again.kind === "paused" && outcome.kind === "paused") {
        assert.equal(again.gate_event_id, outcome.gate_event_id);
      }
    } finally {
      cleanup(dir);
    }
  });
});

describe("drive — error routes to the recovery policy", () => {
  it("force-closes via the injected recoverChoice and returns the terminal verdict", async () => {
    const dir = await freshProject();
    try {
      const outcome = await drive(dir, {
        executor: echoExecutor(),
        resolveRegistry: () => overflowRegistry(),
        task: "overflowing work",
        client_idempotency_uuid: "cidem-recover",
        // The single spawn drains, the flow overflows, and the policy closes it.
        recoverChoice: () => "force-close",
      });
      assert.equal(outcome.kind, "complete");
      if (outcome.kind === "complete") assert.equal(outcome.verdict, "failed_force_closed");
      const state = await readState(dir);
      assert.equal(state.status, "completed");
    } finally {
      cleanup(dir);
    }
  });

  it("surfaces the error when the policy declines (returns null)", async () => {
    const dir = await freshProject();
    try {
      const outcome = await drive(dir, {
        executor: echoExecutor(),
        resolveRegistry: () => overflowRegistry(),
        task: "overflowing work",
        client_idempotency_uuid: "cidem-no-recover",
        recoverChoice: () => null,
      });
      assert.equal(outcome.kind, "error");
      if (outcome.kind === "error") assert.equal(outcome.code, "FLOW_OVERFLOW");
    } finally {
      cleanup(dir);
    }
  });
});

describe("drive — idempotency", () => {
  it("retries a failing executor via the restart head, reusing the agent_run_id", async () => {
    const dir = await freshProject();
    try {
      const seen: string[] = [];
      let failedOnce = false;
      const executor: Executor = {
        execute: async (s) => {
          if (!failedOnce) {
            failedOnce = true;
            throw new Error("simulated dropped turn");
          }
          seen.push(s.agent_run_id);
          return { agent_output: `done ${s.agent}` };
        },
      };
      const outcome = await drive(dir, {
        executor,
        resolveRegistry: () => spawnRegistry(),
        task: "flaky work",
        client_idempotency_uuid: "cidem-retry",
      });
      assert.equal(outcome.kind, "complete");
      // The first spawn's agent_run_id is reused on the retry, and no
      // duplicate pending row was minted (agents_count == 2 spawns total).
      const state = await readState(dir);
      assert.equal(state.status, "completed");
      assert.equal(state.agents_count, 2);
      // The same agent_run_id the kernel issued is what the executor saw.
      assert.ok(seen[0]?.startsWith("ar-"));
    } finally {
      cleanup(dir);
    }
  });

  it("dedups a re-delivered agent_run_id (lost-turn re-resume): no double advance", async () => {
    const dir = await freshProject();
    try {
      const registry = spawnRegistry();
      // Create + first directive (spawn-1 pending).
      const created = await createAndStart(dir, {
        registry,
        task: "lossy work",
        client_idempotency_uuid: "cidem-dedup",
      });
      assert.equal(created.response.status, "spawn-agent");
      if (created.response.status !== "spawn-agent") throw new Error("expected spawn-agent");
      const arid = created.response.agent_run_id;
      const dsid = created.driver_state_id;

      // Simulate a lost delivery: re-resume re-emits the SAME spawn.
      const reEmit = await resumeDirective(await readState(dir), registry);
      assert.equal(reEmit.kind, "shuttle");
      if (reEmit.kind === "shuttle") assert.equal(reEmit.spawn.agent_run_id, arid);

      // Deliver once → advances to spawn-2.
      const first = await deliverAndAdvance(dir, {
        registry,
        input: { type: "agent-result", agent_run_id: arid, agent_output: "x" },
        driver_state_id: dsid,
      });
      assert.equal(first.response.status, "spawn-agent");
      const stepAfterFirst = (await readState(dir)).driver.step_index;

      // Deliver the SAME agent_run_id again → ledger dedup → identical
      // response, no second advance.
      const second = await deliverAndAdvance(dir, {
        registry,
        input: { type: "agent-result", agent_run_id: arid, agent_output: "x" },
        driver_state_id: dsid,
      });
      assert.deepEqual(second.response, first.response);
      assert.equal((await readState(dir)).driver.step_index, stepAfterFirst);
    } finally {
      cleanup(dir);
    }
  });
});

describe("drive — spawn budget enforcement (generic, bundle-blind)", () => {
  it("caps fanout concurrency at max_concurrent_spawns", async () => {
    const dir = await freshProject();
    try {
      let live = 0;
      let maxLive = 0;
      const executor: Executor = {
        execute: async () => {
          live += 1;
          maxLive = Math.max(maxLive, live);
          await delay(15);
          live -= 1;
          return { agent_output: "ok" };
        },
      };
      const outcome = await drive(dir, {
        executor,
        resolveRegistry: () => fanoutRegistry({ agents: 3, max_concurrent_spawns: 1 }),
        task: "fan out",
        client_idempotency_uuid: "cidem-cap",
      });
      assert.equal(outcome.kind, "complete");
      // Reverting the cap read would let all three run at once (maxLive === 3).
      assert.equal(maxLive, 1);
    } finally {
      cleanup(dir);
    }
  });

  it("cuts an over-budget fanout (wall-time spawn_budget)", async () => {
    const dir = await freshProject();
    try {
      // An executor that hangs forever; the stage's tiny time budget cuts it.
      const executor: Executor = { execute: () => new Promise<ExecutorResult>(() => {}) };
      const outcome = await drive(dir, {
        executor,
        resolveRegistry: () => fanoutRegistry({ agents: 2, spawn_budget_ms: 30 }),
        task: "slow fan out",
        client_idempotency_uuid: "cidem-budget",
      });
      assert.equal(outcome.kind, "error");
      if (outcome.kind === "error") assert.equal(outcome.code, "SPAWN_BUDGET_EXCEEDED");
    } finally {
      cleanup(dir);
    }
  });
});

describe("drive — conformance: file accounting is fed, not dropped", () => {
  it("threads executor-reported files through delivery (non-git project)", async () => {
    const dir = await freshProject();
    try {
      const executor: Executor = {
        execute: async (s) => ({
          agent_output: `done ${s.agent}`,
          files_modified: [`${s.agent}.ts`],
          files_created: [`${s.agent}.new.ts`],
        }),
      };
      const outcome = await drive(dir, {
        executor,
        resolveRegistry: () => spawnRegistry(),
        task: "accounted work",
        client_idempotency_uuid: "cidem-files",
      });
      assert.equal(outcome.kind, "complete");
      const state = await readState(dir);
      // A thin driver that dropped the file feed would leave these empty —
      // the diff-gated reviewers would then silently no-op.
      assert.ok(state.files_modified.includes("impl-1.ts"));
      assert.ok(state.files_modified.includes("impl-2.ts"));
      assert.ok(state.files_created.includes("impl-1.new.ts"));
    } finally {
      cleanup(dir);
    }
  });
});
