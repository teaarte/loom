import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildVocabularies,
  captureNow,
  closeDb,
  initializeTask,
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
  type Transaction,
  type UserAnswerSchema,
} from "@loomfsm/kernel";

import {
  createContinueTaskTool,
  createRecoverTool,
  createResumeTool,
  createRunTaskTool,
} from "../src/index.js";

const FIXED_NOW = "2026-05-28T10:00:00.000Z";

// A fixed schema the gate fixture re-derives — its presence on a resumed
// ask proves resume rebuilt the directive (valid_answers is NOT stored on
// pending_user_answer), not merely echoed the persisted blob.
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

function stubProvider(idempotent = true): LLMProvider {
  return {
    name: "stub",
    capabilities: { execution: "shuttle", idempotent_spawn: idempotent, reports_usage: false },
    async spawn() {
      throw new Error("stub provider spawn must not be called from the transport test");
    },
  };
}

// A two-spawn flow that terminates at a finalize stage, so an e2e drive
// reaches `complete`. `idempotent` controls the stub provider so the
// non-idempotent re-shuttle refusal can be exercised.
function buildRegistry(idempotent = true): Registry {
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
    flows: { standard: flow },
    hooks: [],
    invariants: [],
  };
  const provider = stubProvider(idempotent);
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

// A flow whose first stage is a human-required gate, so run_task parks at
// an ask-user the resume tool must reconstruct.
function buildGateRegistry(): Registry {
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
  const bundle: Bundle = {
    name: "code-fixture",
    version: "1.0.0",
    description: "gate fixture bundle",
    phases: ["work"],
    default_flow: "standard",
    default_gate_policies: {} as Record<GateRole, PolicyName>,
    gate_roles: {},
    agents: [],
    stages,
    flows: { standard: flow },
    hooks: [],
    invariants: [],
  };
  const provider = stubProvider();
  const policyFactories = new Map<PolicyName, () => Policy>();
  policyFactories.set("human", () => () => ({ type: "human-required", reason: "test" }));
  return {
    bundle,
    agents: new Map(),
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

interface Harness {
  dir: string;
  allowlistPath: string;
  registry: Registry;
}

async function freshHarness(registry: Registry = buildRegistry()): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "loom-resume-"));
  openDb(dir);
  await reconcileExtensions({
    manifests: [bundleManifest("code-fixture")],
    project_dir: dir,
    now: FIXED_NOW as never,
  });
  const allowlistPath = join(dir, "projects.allow");
  writeFileSync(allowlistPath, `${realpathSync(dir)}\n`, "utf8");
  return { dir, allowlistPath, registry };
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
  return {
    run: createRunTaskTool(deps),
    cont: createContinueTaskTool(deps),
    recover: createRecoverTool(deps),
    resume: createResumeTool(deps),
  };
}

// Create a task and return its driver_state_id + the first spawn's pending
// agent_run_id (the row a resume re-shuttles).
async function bootstrap(h: Harness, uuid: string) {
  const { run } = tools(h);
  const res = await run({ project_dir: h.dir, task: "do work", client_idempotency_uuid: uuid });
  assert.equal(res.response.status, "spawn-agent");
  if (res.response.status !== "spawn-agent") throw new Error("expected spawn-agent");
  return { driver_state_id: res.driver_state_id as string, agent_run_id: res.response.agent_run_id };
}

async function ledgerCount(dir: string): Promise<number> {
  return await withStateTransaction(dir, captureNow(), async (tx) => {
    const row = await tx.queryRow<{ n: unknown }>(
      "SELECT COUNT(*) AS n FROM kernel_idempotency_ledger",
    );
    return Number(row?.n ?? 0);
  });
}

describe("pipeline_resume", () => {
  it("re-emits the pending spawn reusing the SAME agent_run_id", async () => {
    const h = await freshHarness();
    try {
      const { agent_run_id } = await bootstrap(h, "uuid-1");
      const { resume } = tools(h);
      const res = await resume({ project_dir: h.dir });
      assert.equal(res.response.status, "spawn-agent");
      if (res.response.status === "spawn-agent") {
        // The exact same pending row, not a fresh begin_spawn.
        assert.equal(res.response.agent_run_id, agent_run_id);
        assert.equal(res.response.agent, "impl-1");
      }
    } finally {
      cleanup(h.dir);
    }
  });

  it("is read-only: a repeat resume returns the same directive and writes nothing", async () => {
    const h = await freshHarness();
    try {
      await bootstrap(h, "uuid-2");
      const { resume } = tools(h);

      const before = await withStateTransaction(h.dir, captureNow(), loadState);
      const ledgerBefore = await ledgerCount(h.dir);

      const first = await resume({ project_dir: h.dir });
      const second = await resume({ project_dir: h.dir });

      const after = await withStateTransaction(h.dir, captureNow(), loadState);
      const ledgerAfter = await ledgerCount(h.dir);

      // Same directive both times.
      assert.deepEqual(second.response, first.response);
      // No advance, no extra pending row, no ledger write — pure read.
      assert.equal(after.driver.step_index, before.driver.step_index);
      assert.equal(after.pending_agents.length, before.pending_agents.length);
      assert.equal(after.agents_count, before.agents_count);
      assert.equal(ledgerAfter, ledgerBefore);
    } finally {
      cleanup(h.dir);
    }
  });

  it("reconstructs the ask-user for a task parked at a human gate (same gate_event_id)", async () => {
    const h = await freshHarness(buildGateRegistry());
    try {
      const { run, resume } = tools(h);
      const created = await run({
        project_dir: h.dir,
        task: "gated work",
        client_idempotency_uuid: "uuid-ask",
      });
      assert.equal(created.response.status, "ask-user");
      if (created.response.status !== "ask-user") throw new Error("expected ask-user");
      const originalEventId = created.response.gate_event_id;

      const before = await withStateTransaction(h.dir, captureNow(), loadState);

      const res = await resume({ project_dir: h.dir });
      assert.equal(res.response.status, "ask-user");
      if (res.response.status === "ask-user") {
        // The gate_event_id is the PERSISTED one (binding preserved), not a
        // freshly-minted one — a blind re-tick would have replaced it.
        assert.equal(res.response.gate_event_id, originalEventId);
        assert.equal(res.response.gate, "gate-1");
        assert.equal(res.response.message, "Approve the plan?");
        // valid_answers is NOT stored on pending_user_answer — its presence
        // proves resume re-derived it from the gate stage.
        assert.deepEqual(res.response.valid_answers, GATE_SCHEMA);
      }

      // The persisted pending answer's gate_event_id is untouched on disk.
      const after = await withStateTransaction(h.dir, captureNow(), loadState);
      assert.equal(
        after.driver.pending_user_answer?.gate_event_id,
        before.driver.pending_user_answer?.gate_event_id,
      );
    } finally {
      cleanup(h.dir);
    }
  });

  it("re-emits a complete envelope for a terminal task", async () => {
    const h = await freshHarness();
    try {
      const { driver_state_id } = await bootstrap(h, "uuid-term");
      const { recover, resume } = tools(h);
      // Abandon the task so the slot holds a terminal record.
      const abandoned = await recover({ project_dir: h.dir, driver_state_id, choice: "abandon" });
      assert.equal(abandoned.response.status, "complete");

      const res = await resume({ project_dir: h.dir });
      assert.equal(res.response.status, "complete");
      if (res.response.status === "complete") {
        // abandoned → NULL verdict maps to the rejected terminal on the wire.
        assert.equal(res.response.verdict, "rejected");
      }
    } finally {
      cleanup(h.dir);
    }
  });

  it("returns NO_ACTIVE_TASK for a project with no task", async () => {
    const h = await freshHarness();
    try {
      const { resume } = tools(h);
      const res = await resume({ project_dir: h.dir });
      assert.equal(res.response.status, "error");
      if (res.response.status === "error") {
        assert.equal(res.response.code, "NO_ACTIVE_TASK");
      }
    } finally {
      cleanup(h.dir);
    }
  });

  it("re-ticks a freshly-created task that never produced its first directive", async () => {
    const h = await freshHarness();
    try {
      // Simulate a host that died after create but before the first
      // directive committed: initialize the task directly (no runFSM), so
      // the slot is in_progress with no pending agents and no pending ask.
      await withStateTransaction(h.dir, captureNow(), async (tx: Transaction) => {
        await initializeTask(tx, {
          project_dir: h.dir,
          task: "half-created",
          task_short: null,
          owner_id: "anonymous",
          stack: null,
          client_idempotency_uuid: "uuid-halfcreate",
          phases: h.registry.bundle.phases,
          flow_name: h.registry.bundle.default_flow,
        });
      });

      const seeded = await withStateTransaction(h.dir, captureNow(), loadState);
      assert.equal(seeded.status, "in_progress");
      assert.equal(seeded.pending_agents.length, 0);
      assert.equal(seeded.driver.pending_user_answer, null);

      const { resume } = tools(h);
      const res = await resume({ project_dir: h.dir });
      // The runFSM fallback re-emits the first directive.
      assert.equal(res.response.status, "spawn-agent");
      if (res.response.status === "spawn-agent") {
        assert.equal(res.response.agent, "impl-1");
      }
    } finally {
      cleanup(h.dir);
    }
  });

  it("refuses with REGISTRY_UNAVAILABLE on the active-task path when no resolver is wired", async () => {
    const h = await freshHarness();
    try {
      await bootstrap(h, "uuid-noreg");
      // No resolveRegistry — an in-progress task has no flow to re-shape.
      const resume = createResumeTool({ allowlistPath: h.allowlistPath });
      const res = await resume({ project_dir: h.dir });
      assert.equal(res.response.status, "error");
      if (res.response.status === "error") {
        assert.equal(res.response.code, "REGISTRY_UNAVAILABLE");
      }
    } finally {
      cleanup(h.dir);
    }
  });

  it("refuses a pending re-shuttle under a non-idempotent provider", async () => {
    const h = await freshHarness(buildRegistry(false));
    try {
      await bootstrap(h, "uuid-nonidem");
      const { resume } = tools(h);
      const res = await resume({ project_dir: h.dir });
      assert.equal(res.response.status, "error");
      if (res.response.status === "error") {
        assert.equal(res.response.code, "PROVIDER_NOT_IDEMPOTENT");
      }
    } finally {
      cleanup(h.dir);
    }
  });

  it("e2e: lose the delivery, resume, deliver — task reaches complete; a repeat delivery dedups", async () => {
    const h = await freshHarness();
    try {
      const { driver_state_id, agent_run_id } = await bootstrap(h, "uuid-e2e");
      const { cont, resume } = tools(h);

      // Delivery is "lost" (never sent). Resume re-attaches and re-emits the
      // pending spawn with the same agent_run_id.
      const resumed = await resume({ project_dir: h.dir });
      assert.equal(resumed.response.status, "spawn-agent");
      if (resumed.response.status === "spawn-agent") {
        assert.equal(resumed.response.agent_run_id, agent_run_id);
      }

      // Now deliver the first result — the loop advances to the second spawn.
      const afterFirst = await cont({
        project_dir: h.dir,
        driver_state_id,
        input: { type: "agent-result", agent_run_id, agent_output: "done" },
      });
      assert.equal(afterFirst.response.status, "spawn-agent");
      if (afterFirst.response.status !== "spawn-agent") throw new Error("expected spawn-agent");
      const secondArid = afterFirst.response.agent_run_id;

      // A repeat delivery of the SAME agent_run_id dedups via the ledger —
      // identical next directive, no double advance.
      const replay = await cont({
        project_dir: h.dir,
        driver_state_id,
        input: { type: "agent-result", agent_run_id, agent_output: "done" },
      });
      assert.deepEqual(replay.response, afterFirst.response);

      // Deliver the second result — the flow finalizes to complete.
      const done = await cont({
        project_dir: h.dir,
        driver_state_id,
        input: { type: "agent-result", agent_run_id: secondArid, agent_output: "done" },
      });
      assert.equal(done.response.status, "complete");

      // A resume after completion reports the task is done.
      const afterComplete = await resume({ project_dir: h.dir });
      assert.equal(afterComplete.response.status, "complete");
    } finally {
      cleanup(h.dir);
    }
  });
});
