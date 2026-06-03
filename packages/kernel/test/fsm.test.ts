import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { runFSM } from "../src/fsm.js";
import {
  _resetInvariantsForTest,
} from "../src/invariants.js";
import { buildVocabularies } from "../src/vocabularies.js";
import { deliverContinue } from "../src/lib/deliver-continue.js";
import { persistAgentResult } from "../src/lib/persist-agent-result.js";
import {
  KernelError,
  captureNow,
  closeDb,
  loadState,
  openDb,
  withStateTransaction,
} from "../src/state.js";
import type { BundleOp, StageContext } from "../src/types/context.js";
import type { Bundle } from "../src/types/bundle.js";
import type { NowToken } from "../src/types/now.js";
import type {
  Agent,
  ConditionalSpawnContext,
  FanoutStage,
  FinalizeStage,
  GateStage,
  HookEvent,
  SpawnStage,
  Stage,
  StageResult,
  StepStage,
} from "../src/types/plugins.js";
import type { Policy, PolicyName } from "../src/types/policy.js";
import type { LLMProvider, ProviderShuttleIntent } from "../src/types/provider.js";
import type { Registry } from "../src/types/registry.js";
import type { GateRole } from "../src/types/row-types.js";
import type { BundleStateView, PipelineState } from "../src/types/state.js";
import type { UserAnswer } from "../src/types/user-answer.js";

// ============================================================================
// Fixture helpers
// ============================================================================

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "loom-fsm-"));
}

function cleanup(projectDir: string): void {
  try {
    closeDb(projectDir);
  } catch {
    /* may have already closed */
  }
  rmSync(projectDir, { recursive: true, force: true });
}

async function seedBaseline(
  projectDir: string,
  opts: {
    flow_name: string;
    step_index?: number;
    decisions?: string;
    bundle_state?: string;
    verdict?: PipelineState["verdict"];
    // Seed phase 'p1' with this status. Tests that pre-set
    // `verdict` need a terminal phase status (`completed` or
    // `skipped`) to avoid tripping INV_007 on the seed commit.
    phase_status?: "pending" | "in_progress" | "completed" | "skipped";
    phase_skipped_reason?: string;
  },
): Promise<NowToken> {
  const now = captureNow();
  const phaseStatus = opts.phase_status ?? "pending";
  const skippedReason =
    phaseStatus === "skipped" ? (opts.phase_skipped_reason ?? "seeded for finalize test") : null;
  await withStateTransaction(projectDir, now, async (tx) => {
    await tx.exec(
      "INSERT INTO pipeline_state (id, schema_version, project_dir, bundle, " +
        "task, task_id, driver_state_id, status, verdict, started_at, " +
        "decisions, bundle_state) " +
        "VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "3.0.0",
        projectDir,
        "stub-bundle",
        "fsm fixture",
        "t-2026-05-28-fixture",
        "d-fixture",
        "in_progress",
        opts.verdict ?? null,
        now,
        opts.decisions ?? "{}",
        opts.bundle_state ?? null,
      ],
    );
    await tx.exec(
      "INSERT INTO driver_state (id, flow_name, step_index, complete) " +
        "VALUES (1, ?, ?, 0)",
      [opts.flow_name, opts.step_index ?? 0],
    );
    await tx.exec("INSERT INTO pipeline_counters (id) VALUES (1)");
    await tx.exec(
      "INSERT INTO phases (name, status, skipped_reason, updated_at) VALUES ('p1', ?, ?, ?)",
      [phaseStatus, skippedReason, now],
    );
  });
  return now;
}

// In-memory PipelineState used by runFSM. Construction mirrors the
// rows seeded above so the loop sees the same view loadState would
// produce.
function buildInMemoryState(
  projectDir: string,
  now: NowToken,
  opts: {
    flow_name: string;
    step_index?: number;
    decisions?: Record<string, unknown>;
    verdict?: PipelineState["verdict"];
    phase_status?: "pending" | "in_progress" | "completed" | "skipped";
  },
): PipelineState {
  return {
    schema_version: "3.0.0",
    task_id: "t-2026-05-28-fixture",
    driver_state_id: "d-fixture",
    project_dir: projectDir,
    bundle: "stub-bundle",
    task: "fsm fixture",
    task_short: null,
    owner_id: null,
    status: "in_progress",
    verdict: opts.verdict ?? null,
    started_at: now,
    ended_at: null,
    gate_policies: {} as Record<GateRole, PolicyName>,
    decisions: opts.decisions ?? {},
    bundle_state: null,
    pipeline_violation: null,
    force_used: false,
    agents_count: 0,
    gate_revisions: {} as Record<GateRole, number>,
    gate_auto_rejections: {} as Record<GateRole, number>,
    files_created: [],
    files_modified: [],
    total_tokens_in: 0,
    total_tokens_out: 0,
    total_tokens_cached: 0,
    driver: {
      flow_name: opts.flow_name,
      step_index: opts.step_index ?? 0,
      complete: false,
      pending_user_answer: null,
      scratch: {},
    },
    phases: [
      {
        name: "p1",
        status: opts.phase_status ?? "pending",
        skipped_reason:
          opts.phase_status === "skipped" ? "seeded for finalize test" : null,
        phase_extension: null,
        updated_at: now,
      },
    ],
    gates: {},
    agent_verdicts: [],
    pending_agents: [],
    now,
  };
}

// Stub provider — deterministic name, capabilities marker for the
// shuttle path. The FSM test never invokes `spawn()`; the test
// harness simulates result delivery directly via persistAgentResult.
function makeStubProvider(): LLMProvider {
  return {
    name: "stub-provider",
    capabilities: {
      execution: "shuttle",
      idempotent_spawn: true,
      reports_usage: true,
    },
    async spawn() {
      throw new Error("stub-provider.spawn() must not be called from the FSM test harness");
    },
  };
}

function humanRequiredPolicyFactory(): Policy {
  return () => ({
    type: "human-required" as const,
    reason: "test-default-human",
  });
}

function autoApprovePolicyFactory(): Policy {
  return () => ({
    type: "auto-approve" as const,
    reason: "test-auto-approve",
  });
}

function autoRejectRevisePolicyFactory(): Policy {
  return () => ({
    type: "auto-reject" as const,
    reason: "test-auto-reject",
    reject_intent: "revise" as const,
  });
}

function makeAgent(name: string, opts: { applies?: boolean } = {}): Agent {
  const agent: Agent = {
    name,
    template_path: `templates/${name}.md`,
    output_kind: "nonreview",
  };
  if (opts.applies === false) {
    agent.applies_to = () => false;
  }
  return agent;
}

// Build a Registry around the supplied stages + flow + agents.
function buildRegistry(opts: {
  stages: Record<string, Stage>;
  flow: string[];
  agents?: Agent[];
  policies?: Partial<Record<PolicyName, () => Policy>>;
}): Registry {
  const stages = new Map<string, Stage>();
  for (const [k, v] of Object.entries(opts.stages)) stages.set(k, v);
  const agents = new Map<string, Agent>();
  for (const a of opts.agents ?? []) agents.set(a.name, a);
  const flows = new Map<string, string[]>();
  flows.set("default", opts.flow);

  const provider = makeStubProvider();
  const bundle: Bundle = {
    name: "stub-bundle",
    version: "0.0.1",
    description: "FSM test fixture bundle",
    phases: ["p1"],
    default_flow: "default",
    default_gate_policies: { plan: "human" } as Record<GateRole, PolicyName>,
    gate_roles: { "g1": "plan", "g2": "plan" },
    agents: opts.agents ?? [],
    stages: opts.stages,
    flows: { default: opts.flow },
    hooks: [],
    invariants: [],
  };

  const policyFactories = new Map<PolicyName, () => Policy>();
  policyFactories.set("human", humanRequiredPolicyFactory);
  if (opts.policies) {
    for (const [k, v] of Object.entries(opts.policies)) {
      if (v !== undefined) policyFactories.set(k, v);
    }
  }

  return {
    bundle,
    agents,
    stages,
    flows,
    hooks: [],
    invariants: [],
    mcp_clients: new Map(),
    providers: {
      resolve: () => provider,
      all: [provider],
      health_check_all: Promise.resolve([
        { name: provider.name, healthy: true },
      ]),
    },
    policyFactories,
    vocabularies: buildVocabularies(bundle),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("runFSM — flow control", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("advances through marker + positional Step + gate, returns ask-user", async () => {
    const stages: Record<string, Stage> = {
      m1: { kind: "step", name: "m1", phase: "p1", position: "positional", effects: [] },
      "step-compute": {
        kind: "step",
        name: "step-compute",
        phase: "p1",
        position: "positional",
        effects: [{ kind: "decisions.set", key: "computed" }],
        run: async (_state, ctx) => {
          ctx.tx.set_decision?.("computed", "yes");
        },
      },
      g1: {
        kind: "gate",
        name: "g1",
        phase: "p1",
        message: () => "Proceed?",
        valid_answers: () => ({ options: [
          { verbs: ["yes"], label: "Approve", produces: { decision: "accept" } },
        ]}),
      },
      finalize: { kind: "finalize", name: "finalize" },
    };
    const flow = ["m1", "step-compute", "g1", "finalize"];
    const registry = buildRegistry({ stages, flow });

    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    const out = await runFSM(state, registry);
    assert.equal(out.directive.kind, "ask-user");
    if (out.directive.kind === "ask-user") {
      assert.equal(out.directive.gate, "g1");
      assert.ok(out.directive.gate_event_id.startsWith("gev-"));
      assert.equal(out.directive.message, "Proceed?");
    }
    // step-compute advanced from index 1 to 2; gate halted at 2.
    assert.equal(state.driver.step_index, 2);
  });

  it("step-compute commits decisions to disk via applyBundleOps", async () => {
    const stages: Record<string, Stage> = {
      "step-compute": {
        kind: "step",
        name: "step-compute",
        phase: "p1",
        position: "positional",
        effects: [{ kind: "decisions.set", key: "computed" }],
        run: async (_s, ctx) => {
          ctx.tx.set_decision?.("computed", "yes");
        },
      },
      g1: {
        kind: "gate",
        name: "g1",
        phase: "p1",
        message: () => "ok?",
        valid_answers: () => ({ options: [] }),
      },
    };
    const registry = buildRegistry({
      stages,
      flow: ["step-compute", "g1"],
    });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    await runFSM(state, registry);
    const persistedNow = captureNow();
    const persisted = await withStateTransaction(projectDir, persistedNow, (tx) =>
      loadState(tx),
    );
    assert.equal(persisted.decisions["computed"], "yes");
  });

  it("FLOW_OVERFLOW when step_index >= flow length", async () => {
    const stages: Record<string, Stage> = {
      m1: { kind: "step", name: "m1", phase: "p1", position: "positional", effects: [] },
    };
    const registry = buildRegistry({ stages, flow: ["m1"] });
    const now = await seedBaseline(projectDir, { flow_name: "default", step_index: 1 });
    const state = buildInMemoryState(projectDir, now, {
      flow_name: "default",
      step_index: 1,
    });

    const out = await runFSM(state, registry);
    assert.equal(out.directive.kind, "error");
    if (out.directive.kind === "error") {
      assert.equal(out.directive.code, "FLOW_OVERFLOW");
    }
  });

  it("FLOW_NOT_REGISTERED when flow_name has no registry entry", async () => {
    const registry = buildRegistry({ stages: {}, flow: [] });
    const now = await seedBaseline(projectDir, { flow_name: "missing" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "missing" });

    const out = await runFSM(state, registry);
    assert.equal(out.directive.kind, "error");
    if (out.directive.kind === "error") {
      assert.equal(out.directive.code, "FLOW_NOT_REGISTERED");
    }
  });

  it("STAGE_NOT_REGISTERED when flow references unknown stage", async () => {
    const registry = buildRegistry({ stages: {}, flow: ["nonexistent"] });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    const out = await runFSM(state, registry);
    assert.equal(out.directive.kind, "error");
    if (out.directive.kind === "error") {
      assert.equal(out.directive.code, "STAGE_NOT_REGISTERED");
    }
  });

  it("WALK_BACK_TARGET_NOT_FOUND when gate on_resume points to an unknown step", async () => {
    const stages: Record<string, Stage> = {
      g1: {
        kind: "gate",
        name: "g1",
        phase: "p1",
        message: () => "",
        valid_answers: () => ({ options: [] }),
        on_resume: async () => ({
          type: "walk_back_to" as const,
          step: "no-such-step",
          reason: "test",
        }),
      },
    };
    const registry = buildRegistry({
      stages,
      flow: ["g1"],
      policies: { human: autoApprovePolicyFactory },
    });
    const now = await seedBaseline(projectDir, {
      flow_name: "default",
      decisions: JSON.stringify({}),
    });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    const out = await runFSM(state, registry);
    assert.equal(out.directive.kind, "error");
    if (out.directive.kind === "error") {
      assert.equal(out.directive.code, "WALK_BACK_TARGET_NOT_FOUND");
    }
  });

  it("walk_back_to rewinds step_index when target exists", async () => {
    const stages: Record<string, Stage> = {
      m1: { kind: "step", name: "m1", phase: "p1", position: "positional", effects: [] },
      g1: {
        kind: "gate",
        name: "g1",
        phase: "p1",
        message: () => "",
        valid_answers: () => ({ options: [] }),
        on_resume: async () => ({
          type: "walk_back_to" as const,
          step: "m1",
          reason: "loop-back",
        }),
      },
      // sentinel forcing the second loop to halt with a directive
      // we can assert against — bare walk_back rewinds to m1, m1
      // advances, then g1 fires again and the policy switches to
      // ask-user the second time around.
      g2: {
        kind: "gate",
        name: "g2",
        phase: "p1",
        message: () => "halt",
        valid_answers: () => ({ options: [] }),
      },
    };
    let firstCall = true;
    const policy: Policy = () => {
      if (firstCall) {
        firstCall = false;
        return { type: "auto-approve" as const, reason: "first" };
      }
      return { type: "human-required" as const, reason: "second" };
    };
    const registry = buildRegistry({
      stages,
      flow: ["m1", "g1", "g2"],
      policies: { human: () => policy },
    });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    const out = await runFSM(state, registry);
    // First visit to g1 auto-approved + walked back to m1; m1
    // advanced again; second visit to g1 returned human-required.
    // Asserting `step_index === 1` proves the rewind happened
    // (m1 sits at index 0; without the rewind we'd be at 2 or 3).
    assert.equal(out.directive.kind, "ask-user");
    if (out.directive.kind === "ask-user") {
      assert.equal(out.directive.gate, "g1");
    }
    assert.equal(state.driver.step_index, 1);
  });
});

describe("runFSM — gate → user-answer round-trip", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("persists the pending answer + gate_event_id so the continue path is not stale", async () => {
    const stages: Record<string, Stage> = {
      g1: {
        kind: "gate",
        name: "g1",
        phase: "p1",
        message: () => "Proceed?",
        valid_answers: () => ({
          options: [
            { verbs: ["yes"], label: "Approve", produces: { decision: "accept" } },
          ],
        }),
      },
    };
    // The default `human` policy parks at the gate (human-required).
    const registry = buildRegistry({ stages, flow: ["g1"] });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    const out = await runFSM(state, registry);
    assert.equal(out.directive.kind, "ask-user");
    const gateEventId =
      out.directive.kind === "ask-user" ? out.directive.gate_event_id : "";
    assert.ok(gateEventId.startsWith("gev-"));

    // The writer (FSM tick) persisted the pending answer WITH the issued
    // gate_event_id, in the same tick's tx.
    const parked = await withStateTransaction(projectDir, captureNow(), (tx) =>
      loadState(tx),
    );
    assert.ok(parked.driver.pending_user_answer !== null);
    assert.equal(parked.driver.pending_user_answer?.gate, "g1");
    assert.equal(parked.driver.pending_user_answer?.gate_event_id, gateEventId);

    // The matching user-answer delivers end-to-end — the existing reader's
    // `pending.gate_event_id === input.gate_event_id` check passes, so no
    // GATE_EVENT_STALE.
    await withStateTransaction(projectDir, captureNow(), (tx) =>
      deliverContinue(tx, {
        input: {
          type: "user-answer",
          gate_event_id: gateEventId,
          decision: "accept",
          message: "ok",
        },
        driver_state_id: state.driver_state_id,
      }),
    );

    const after = await withStateTransaction(projectDir, captureNow(), (tx) =>
      loadState(tx),
    );
    assert.equal(after.driver.pending_user_answer, null); // cleared on delivery
    const gate = after.gates["g1"];
    assert.ok(gate);
    assert.equal(gate?.status, "approved");
    assert.equal(gate?.decided_by, "human");
    assert.equal(gate?.feedback, "ok");
  });

  it("a mismatched gate_event_id is refused as stale after a real park", async () => {
    const stages: Record<string, Stage> = {
      g1: {
        kind: "gate",
        name: "g1",
        phase: "p1",
        message: () => "Proceed?",
        valid_answers: () => ({ options: [] }),
      },
    };
    const registry = buildRegistry({ stages, flow: ["g1"] });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    const out = await runFSM(state, registry);
    assert.equal(out.directive.kind, "ask-user");

    // A different id than the one that was issued must not satisfy the gate.
    await assert.rejects(
      withStateTransaction(projectDir, captureNow(), (tx) =>
        deliverContinue(tx, {
          input: {
            type: "user-answer",
            gate_event_id: "gev-00000000-0000-0000-0000-0000000000ff",
            decision: "accept",
          },
          driver_state_id: state.driver_state_id,
        }),
      ),
      (err: unknown) => err instanceof KernelError && err.code === "GATE_EVENT_STALE",
    );
  });
});

describe("runFSM — spawn / fanout directives", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("SpawnStage emits a shuttle directive carrying the agent_run_id", async () => {
    const stages: Record<string, Stage> = {
      "spawn-1": { kind: "spawn", name: "spawn-1", phase: "p1", agent: "stub-agent" },
    };
    const registry = buildRegistry({
      stages,
      flow: ["spawn-1"],
      agents: [makeAgent("stub-agent")],
    });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    const out = await runFSM(state, registry);
    assert.equal(out.directive.kind, "shuttle");
    if (out.directive.kind === "shuttle") {
      assert.equal(out.directive.spawn.agent, "stub-agent");
      assert.ok(out.directive.spawn.agent_run_id.startsWith("ar-"));
      assert.equal(out.directive.spawn.phase, "p1");
    }
  });

  it("SpawnStage persists the resolved model on the pending_agents row", async () => {
    const stages: Record<string, Stage> = {
      "spawn-1": { kind: "spawn", name: "spawn-1", phase: "p1", agent: "m-agent" },
    };
    const agent: Agent = {
      name: "m-agent",
      template_path: "templates/m-agent.md",
      output_kind: "nonreview",
      default_model: "fast",
    };
    const registry = buildRegistry({ stages, flow: ["spawn-1"], agents: [agent] });
    // The bundle maps the agent's declared tier to a concrete model — what the
    // driver dispatches and what the store must record (previously dead: the
    // column defaulted to null because the bundle passes no explicit model).
    registry.bundle.default_model_tiers = { fast: "claude-haiku-4-5" };

    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    const out = await runFSM(state, registry);
    assert.equal(out.directive.kind, "shuttle");

    const db = openDb(projectDir);
    const row = db
      .prepare("SELECT model FROM pending_agents WHERE agent = ?")
      .get("m-agent") as { model?: unknown } | undefined;
    assert.equal(row?.model, "claude-haiku-4-5");
  });

  it("FanoutStage emits a shuttle-batch directive with one spawn per surviving sibling", async () => {
    const stages: Record<string, Stage> = {
      f1: {
        kind: "fanout",
        name: "f1",
        phase: "p1",
        agents: ["a1", "a2", "a3"],
      } as FanoutStage,
    };
    const registry = buildRegistry({
      stages,
      flow: ["f1"],
      agents: [makeAgent("a1"), makeAgent("a2"), makeAgent("a3")],
    });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    const out = await runFSM(state, registry);
    assert.equal(out.directive.kind, "shuttle-batch");
    if (out.directive.kind === "shuttle-batch") {
      assert.equal(out.directive.spawns.length, 3);
      const agents = out.directive.spawns.map((s) => s.agent).sort();
      assert.deepEqual(agents, ["a1", "a2", "a3"]);
    }
  });

  it("SpawnStage advances when Agent.applies_to returns false (no shuttle emitted)", async () => {
    const stages: Record<string, Stage> = {
      "spawn-skipped": {
        kind: "spawn",
        name: "spawn-skipped",
        phase: "p1",
        agent: "skipper",
      },
      g1: {
        kind: "gate",
        name: "g1",
        phase: "p1",
        message: () => "",
        valid_answers: () => ({ options: [] }),
      },
    };
    const registry = buildRegistry({
      stages,
      flow: ["spawn-skipped", "g1"],
      agents: [makeAgent("skipper", { applies: false })],
    });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    const out = await runFSM(state, registry);
    // The spawn advanced; the gate (human-required) halts.
    assert.equal(out.directive.kind, "ask-user");
    // No pending_agents row should have been written.
    const after = await withStateTransaction(projectDir, captureNow(), (tx) =>
      loadState(tx),
    );
    assert.equal(after.pending_agents.length, 0);
  });

  it("SpawnStage halts with AGENT_NOT_REGISTERED when registry lacks the agent", async () => {
    const stages: Record<string, Stage> = {
      "spawn-ghost": {
        kind: "spawn",
        name: "spawn-ghost",
        phase: "p1",
        agent: "ghost-agent",
      },
    };
    const registry = buildRegistry({
      stages,
      flow: ["spawn-ghost"],
      agents: [], // ghost-agent absent on purpose
    });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    const out = await runFSM(state, registry);
    assert.equal(out.directive.kind, "error");
    if (out.directive.kind === "error") {
      assert.equal(out.directive.code, "AGENT_NOT_REGISTERED");
    }
  });

  it("SpawnGuard refuses a second spawn for the same (agent, phase) inside the duplicate window", async () => {
    const stages: Record<string, Stage> = {
      "spawn-1": { kind: "spawn", name: "spawn-1", phase: "p1", agent: "a" },
    };
    const registry = buildRegistry({
      stages,
      flow: ["spawn-1"],
      agents: [makeAgent("a")],
    });
    const now = await seedBaseline(projectDir, { flow_name: "default" });

    // Seed a pending row for the SAME (agent, phase) within the
    // 5-min duplicate window — guard must refuse.
    await withStateTransaction(projectDir, now, async (tx) => {
      await tx.exec(
        "INSERT INTO pending_agents (agent_run_id, agent, phase, model, started_at) " +
          "VALUES ('ar-existing', 'a', 'p1', NULL, ?)",
        [now],
      );
    });

    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });
    state.pending_agents = [
      {
        agent_run_id: "ar-existing",
        agent: "a",
        phase: "p1",
        model: null,
        started_at: now,
      },
    ];

    await assert.rejects(
      () => runFSM(state, registry),
      (err: unknown) => err instanceof KernelError && err.code === "DUPLICATE_SPAWN",
    );
  });

  it("FanoutStage advances when every sibling fails applies_to", async () => {
    const stages: Record<string, Stage> = {
      f1: { kind: "fanout", name: "f1", phase: "p1", agents: ["a1"] },
      g1: {
        kind: "gate",
        name: "g1",
        phase: "p1",
        message: () => "",
        valid_answers: () => ({ options: [] }),
      },
    };
    const registry = buildRegistry({
      stages,
      flow: ["f1", "g1"],
      agents: [makeAgent("a1", { applies: false })],
    });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    const out = await runFSM(state, registry);
    // The fanout advanced; the gate (human-required policy) halted.
    assert.equal(out.directive.kind, "ask-user");
  });
});

describe("runFSM — finalize + auto-policy", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("FinalizeStage emits complete directive when verdict is set", async () => {
    const stages: Record<string, Stage> = {
      finalize: { kind: "finalize", name: "finalize" } as FinalizeStage,
    };
    const registry = buildRegistry({ stages, flow: ["finalize"] });
    // Seed phase 'p1' as already skipped — verdict='accepted' with a
    // pending phase trips INV_007 on the very seeding commit; the
    // Finalize interpreter sweeps non-terminal phases internally,
    // but the SEED isn't running through that path.
    const now = await seedBaseline(projectDir, {
      flow_name: "default",
      verdict: "accepted",
      phase_status: "skipped",
    });
    const state = buildInMemoryState(projectDir, now, {
      flow_name: "default",
      verdict: "accepted",
      phase_status: "skipped",
    });

    const out = await runFSM(state, registry);
    assert.equal(out.directive.kind, "complete");
    if (out.directive.kind === "complete") {
      assert.equal(out.directive.verdict, "accepted");
    }
    assert.equal(state.status, "completed");

    // Verify the commit landed on disk (status flipped + ended_at set).
    const after = await withStateTransaction(projectDir, captureNow(), (tx) =>
      loadState(tx),
    );
    assert.equal(after.status, "completed");
    assert.notEqual(after.ended_at, null);
  });

  it("FinalizeStage resolves an unset verdict to accepted and completes", async () => {
    const stages: Record<string, Stage> = {
      finalize: { kind: "finalize", name: "finalize" } as FinalizeStage,
    };
    const registry = buildRegistry({ stages, flow: ["finalize"] });
    // No verdict seeded; the phase starts pending. Finalize sweeps the
    // phase to skipped and writes the resolved verdict in the same tx, so
    // the verdict/phase-terminality invariant holds on commit.
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    const out = await runFSM(state, registry);
    assert.equal(out.directive.kind, "complete");
    if (out.directive.kind === "complete") {
      assert.equal(out.directive.verdict, "accepted");
    }
    assert.equal(state.status, "completed");

    // The resolved verdict persisted alongside completion.
    const after = await withStateTransaction(projectDir, captureNow(), (tx) =>
      loadState(tx),
    );
    assert.equal(after.status, "completed");
    assert.equal(after.verdict, "accepted");
  });

  it("auto-approve policy advances past the gate without ask-user", async () => {
    const stages: Record<string, Stage> = {
      g1: {
        kind: "gate",
        name: "g1",
        phase: "p1",
        message: () => "",
        valid_answers: () => ({ options: [] }),
      } as GateStage,
      finalize: { kind: "finalize", name: "finalize" },
    };
    const registry = buildRegistry({
      stages,
      flow: ["g1", "finalize"],
      policies: { human: autoApprovePolicyFactory },
    });
    const now = await seedBaseline(projectDir, {
      flow_name: "default",
      verdict: "accepted",
      phase_status: "skipped",
    });
    const state = buildInMemoryState(projectDir, now, {
      flow_name: "default",
      verdict: "accepted",
      phase_status: "skipped",
    });

    const out = await runFSM(state, registry);
    assert.equal(out.directive.kind, "complete");
  });

  it("auto-reject-revise walks back to gate name when on_resume omitted", async () => {
    const stages: Record<string, Stage> = {
      g1: {
        kind: "gate",
        name: "g1",
        phase: "p1",
        message: () => "",
        valid_answers: () => ({ options: [] }),
      },
    };
    const registry = buildRegistry({
      stages,
      flow: ["g1"],
      policies: { human: autoRejectRevisePolicyFactory },
    });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    // Default on_resume on auto-reject is walk_back_to gate name —
    // with only one stage in the flow that loops indefinitely. We
    // patch the policy to flip after the first call so the test
    // terminates.
    let calls = 0;
    const policy: Policy = () => {
      calls += 1;
      if (calls === 1) {
        return {
          type: "auto-reject" as const,
          reason: "first",
          reject_intent: "revise" as const,
        };
      }
      return { type: "human-required" as const, reason: "second" };
    };
    registry.policyFactories.set("human", () => policy);

    const out = await runFSM(state, registry);
    assert.equal(out.directive.kind, "ask-user");
    assert.ok(calls >= 2);
  });
});

describe("interpretStep — error paths", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("event-position Step appearing in flow[] halts with STEP_EVENT_IN_FLOW", async () => {
    const stages: Record<string, Stage> = {
      "event-step": {
        kind: "step",
        name: "event-step",
        position: "event",
        event: "after-agent-result",
        effects: [],
      },
    };
    const registry = buildRegistry({ stages, flow: ["event-step"] });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    const out = await runFSM(state, registry);
    assert.equal(out.directive.kind, "error");
    if (out.directive.kind === "error") {
      assert.equal(out.directive.code, "STEP_EVENT_IN_FLOW");
    }
  });
});

describe("applyBundleOps — multi-variant coverage via Step.run", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("set_bundle_state_field + record_files_modified + record_files_created round-trip onto disk", async () => {
    const stages: Record<string, Stage> = {
      mutator: {
        kind: "step",
        name: "mutator",
        phase: "p1",
        position: "positional",
        effects: [
          { kind: "bundle_state.set", path: "snapshot_hash" },
          { kind: "state.write", field: "files_modified" },
          { kind: "state.write", field: "files_created" },
        ],
        run: async (_state, ctx) => {
          ctx.tx.set_bundle_state_field?.("snapshot_hash", "deadbeef");
          ctx.tx.record_files_modified?.(["src/a.ts", "src/b.ts"]);
          ctx.tx.record_files_created?.(["src/c.ts"]);
        },
      },
      g1: {
        kind: "gate",
        name: "g1",
        phase: "p1",
        message: () => "",
        valid_answers: () => ({ options: [] }),
      },
    };
    const registry = buildRegistry({ stages, flow: ["mutator", "g1"] });
    const now = await seedBaseline(projectDir, {
      flow_name: "default",
      bundle_state: "{}",
    });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    await runFSM(state, registry);

    const persisted = await withStateTransaction(projectDir, captureNow(), (tx) =>
      loadState(tx),
    );
    assert.equal(persisted.bundle_state?.["snapshot_hash"], "deadbeef");
    assert.deepEqual(persisted.files_modified.sort(), ["src/a.ts", "src/b.ts"]);
    assert.deepEqual(persisted.files_created, ["src/c.ts"]);
  });

  it("record_finding pushed from a Step lands under the active stage's phase, not ''", async () => {
    const stages: Record<string, Stage> = {
      flag: {
        kind: "step",
        name: "flag",
        phase: "p1",
        position: "positional",
        effects: [{ kind: "finding.insert", phase: "p1" }],
        run: async (_state, ctx) => {
          ctx.tx.record_finding?.({
            schema_version: "1.0",
            id: "f-2026-05-28-aaaaaa",
            agent: "step-author",
            iteration: 1,
            task_id: "t-2026-05-28-fixture",
            file: "src/x.ts",
            line_start: 1,
            line_end: 2,
            severity: "warn",
            category: "style",
            proposed_new_category: null,
            pattern_id: null,
            summary: "pushed from a Step",
            evidence_excerpt: null,
            suggested_fix: null,
            status: "open",
            ref_rule_id: null,
          });
        },
      },
      g1: {
        kind: "gate",
        name: "g1",
        phase: "p1",
        message: () => "",
        valid_answers: () => ({ options: [] }),
      },
    };
    const registry = buildRegistry({ stages, flow: ["flag", "g1"] });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    await runFSM(state, registry);

    const row = await withStateTransaction(projectDir, captureNow(), (tx) =>
      tx.queryRow<{ phase: string }>(
        "SELECT phase FROM findings WHERE id = 'f-2026-05-28-aaaaaa'",
      ),
    );
    assert.ok(row !== null, "the pushed finding should have landed");
    // The regression: before the active phase was threaded into the
    // scratch-buffer drain, a Step-pushed finding got the empty-string
    // placeholder. It now carries the running phase.
    assert.equal(row?.phase, "p1");
  });

  it("record_files_modified dedupes against the existing array", async () => {
    const stages: Record<string, Stage> = {
      add: {
        kind: "step",
        name: "add",
        phase: "p1",
        position: "positional",
        effects: [{ kind: "state.write", field: "files_modified" }],
        run: async (_state, ctx) => {
          ctx.tx.record_files_modified?.(["x.ts", "y.ts"]);
        },
      },
      "add-overlap": {
        kind: "step",
        name: "add-overlap",
        phase: "p1",
        position: "positional",
        effects: [{ kind: "state.write", field: "files_modified" }],
        run: async (_state, ctx) => {
          // y.ts already there from the first step; z.ts is new.
          ctx.tx.record_files_modified?.(["y.ts", "z.ts"]);
        },
      },
      g: {
        kind: "gate",
        name: "g",
        phase: "p1",
        message: () => "",
        valid_answers: () => ({ options: [] }),
      },
    };
    const registry = buildRegistry({
      stages,
      flow: ["add", "add-overlap", "g"],
    });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    await runFSM(state, registry);
    const persisted = await withStateTransaction(projectDir, captureNow(), (tx) =>
      loadState(tx),
    );
    assert.deepEqual(persisted.files_modified.sort(), ["x.ts", "y.ts", "z.ts"]);
  });

  it("upsert_bundle_row INSERT OR REPLACE on a real bundle-shaped table", async () => {
    // Seed FIRST so pipeline_state exists for invariants on the
    // table-create commit.
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    // Then create a bundle-side table. The kernel allow-list regex
    // accepts any [a-z_][a-z0-9_]* name; the upsert is INSERT OR
    // REPLACE so a row with the same PK overwrites.
    await withStateTransaction(projectDir, now, async (tx) => {
      await tx.exec(
        "CREATE TABLE bundle_diff_snapshots (id TEXT PRIMARY KEY, hash TEXT NOT NULL)",
      );
    });

    const stages: Record<string, Stage> = {
      upsert: {
        kind: "step",
        name: "upsert",
        phase: "p1",
        position: "positional",
        effects: [],
        run: async (_state, ctx) => {
          ctx.tx.upsert_bundle_row?.("bundle_diff_snapshots", {
            id: "snap-1",
            hash: "first",
          });
          ctx.tx.upsert_bundle_row?.("bundle_diff_snapshots", {
            id: "snap-1",
            hash: "second-overwrites-first",
          });
        },
      },
      g: {
        kind: "gate",
        name: "g",
        phase: "p1",
        message: () => "",
        valid_answers: () => ({ options: [] }),
      },
    };
    const registry = buildRegistry({ stages, flow: ["upsert", "g"] });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    await runFSM(state, registry);

    const checkNow = captureNow();
    const hash = await withStateTransaction(projectDir, checkNow, async (tx) => {
      const row = await tx.queryRow<{ hash: string }>(
        "SELECT hash FROM bundle_diff_snapshots WHERE id = 'snap-1'",
      );
      return row?.hash;
    });
    assert.equal(hash, "second-overwrites-first");
  });

  it("upsert_bundle_row refuses table names that fail the allow-list shape", async () => {
    const stages: Record<string, Stage> = {
      bad: {
        kind: "step",
        name: "bad",
        phase: "p1",
        position: "positional",
        effects: [],
        run: async (_state, ctx) => {
          ctx.tx.upsert_bundle_row?.("Has-Dashes!", { id: 1 });
        },
      },
    };
    const registry = buildRegistry({ stages, flow: ["bad"] });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    await assert.rejects(
      () => runFSM(state, registry),
      (err: unknown) => err instanceof KernelError && err.code === "BUNDLE_TABLE_NAME_INVALID",
    );
  });
});

describe("dispatchEventSteps — rollback on throw", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("an event-position Step that throws rolls back the spawn tx (no pending_agents row, no decisions write)", async () => {
    const eventStep: StepStage = {
      kind: "step",
      name: "before-spawn-fail",
      position: "event",
      event: "before-spawn",
      effects: [{ kind: "decisions.set", key: "should-not-land" }],
      run: async (_state, ctx) => {
        ctx.tx.set_decision?.("should-not-land", "yes");
        throw new Error("event-step intentional failure");
      },
    };
    const spawnStage: SpawnStage = {
      kind: "spawn",
      name: "spawn-1",
      phase: "p1",
      agent: "stub-agent",
    };
    const stages: Record<string, Stage> = {
      "spawn-1": spawnStage,
      "before-spawn-fail": eventStep,
    };
    const registry = buildRegistry({
      stages,
      flow: ["spawn-1"],
      agents: [makeAgent("stub-agent")],
    });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    await assert.rejects(() => runFSM(state, registry));

    // Verify the tx rolled back: no pending_agents row, no
    // decisions["should-not-land"] write.
    const checkNow = captureNow();
    const persisted = await withStateTransaction(projectDir, checkNow, (tx) =>
      loadState(tx),
    );
    assert.equal(persisted.pending_agents.length, 0);
    assert.equal(persisted.decisions["should-not-land"], undefined);
  });

  it("an event Step pushing record_finding lands it under the active stage's phase", async () => {
    const eventStep: StepStage = {
      kind: "step",
      name: "before-step-finder",
      position: "event",
      event: "before-step",
      effects: [{ kind: "finding.insert", phase: "p1" }],
      run: async (_state, ctx) => {
        ctx.tx.record_finding?.({
          schema_version: "1.0",
          id: "f-2026-05-28-ev0001",
          agent: "event-author",
          iteration: 1,
          task_id: "t-2026-05-28-fixture",
          file: "src/y.ts",
          line_start: 3,
          line_end: 3,
          severity: "info",
          category: "style",
          proposed_new_category: null,
          pattern_id: null,
          summary: "pushed from an event Step",
          evidence_excerpt: null,
          suggested_fix: null,
          status: "open",
          ref_rule_id: null,
        });
      },
    };
    const stages: Record<string, Stage> = {
      work: { kind: "step", name: "work", phase: "p1", position: "positional", effects: [] },
      "before-step-finder": eventStep,
      g1: {
        kind: "gate",
        name: "g1",
        phase: "p1",
        message: () => "",
        valid_answers: () => ({ options: [] }),
      },
    };
    const registry = buildRegistry({ stages, flow: ["work", "g1"] });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    await runFSM(state, registry);

    // The event Step fires on `before-step` entering `work` (phase p1).
    // Its finding drains through dispatchEventSteps with the active
    // stage's phase — the path the positional test does NOT cover.
    const row = await withStateTransaction(projectDir, captureNow(), (tx) =>
      tx.queryRow<{ phase: string }>(
        "SELECT phase FROM findings WHERE id = 'f-2026-05-28-ev0001'",
      ),
    );
    assert.ok(row !== null, "the event-pushed finding should have landed");
    assert.equal(row?.phase, "p1");
  });
});

describe("persistAgentResult — integration with state core", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("rolls up token counts onto pipeline_counters", async () => {
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    void now;

    const persistNow = captureNow();
    await withStateTransaction(projectDir, persistNow, async (tx) => {
      // Seed a pending row first so the delete in persistAgentResult
      // has something to drain.
      await tx.exec(
        "INSERT INTO pending_agents (agent_run_id, agent, phase, model, started_at) " +
          "VALUES (?, ?, ?, ?, ?)",
        ["ar-test-1", "nonreview-agent", "p1", null, persistNow],
      );
      await persistAgentResult(tx, {
        result: {
          agent: "nonreview-agent",
          agent_run_id: "ar-test-1",
          output: "anything",
          schema_validation: { ok: true },
          tokens: { in: 100, out: 50, cached: 10 },
        },
        output_kind: "nonreview",
        phase: "p1",
        model: "default",
      });
    });

    const checkNow = captureNow();
    const after = await withStateTransaction(projectDir, checkNow, (tx) =>
      loadState(tx),
    );
    assert.equal(after.total_tokens_in, 100);
    assert.equal(after.total_tokens_out, 50);
    assert.equal(after.total_tokens_cached, 10);
    assert.equal(after.agents_count, 1);
    assert.equal(after.pending_agents.length, 0);
  });
});

describe("runFSM — phase progression", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  // Seed two phases p1 + p2, both pending.
  async function seedTwoPhase(): Promise<NowToken> {
    const now = captureNow();
    await withStateTransaction(projectDir, now, async (tx) => {
      await tx.exec(
        "INSERT INTO pipeline_state (id, schema_version, project_dir, bundle, task, task_id, driver_state_id, status, verdict, started_at, decisions) " +
          "VALUES (1, ?, ?, ?, ?, ?, ?, ?, NULL, ?, '{}')",
        ["3.0.0", projectDir, "stub-bundle", "phase fixture", "t-2026-05-28-phase", "d-fixture", "in_progress", now],
      );
      await tx.exec("INSERT INTO driver_state (id, flow_name, step_index, complete) VALUES (1, 'default', 0, 0)");
      await tx.exec("INSERT INTO pipeline_counters (id) VALUES (1)");
      await tx.exec("INSERT INTO phases (name, status, updated_at) VALUES ('p1','pending',?)", [now]);
      await tx.exec("INSERT INTO phases (name, status, updated_at) VALUES ('p2','pending',?)", [now]);
    });
    return now;
  }

  function twoPhaseState(now: NowToken): PipelineState {
    const base = buildInMemoryState(projectDir, now, { flow_name: "default" });
    base.task_id = "t-2026-05-28-phase";
    base.phases = [
      { name: "p1", status: "pending", skipped_reason: null, phase_extension: null, updated_at: now },
      { name: "p2", status: "pending", skipped_reason: null, phase_extension: null, updated_at: now },
    ];
    return base;
  }

  it("a phase walks pending → in_progress → completed; a clean run never ends all-skipped", async () => {
    const stages: Record<string, Stage> = {
      s1: { kind: "spawn", name: "s1", phase: "p1", agent: "a1" } as SpawnStage,
      m2: { kind: "step", name: "m2", phase: "p2", position: "positional", effects: [] } as StepStage,
      finalize: { kind: "finalize", name: "finalize" } as FinalizeStage,
    };
    const registry = buildRegistry({ stages, flow: ["s1", "m2", "finalize"], agents: [makeAgent("a1")] });

    const now = await seedTwoPhase();
    const state = twoPhaseState(now);

    // Tick 1: enters p1 (its first stage is the spawn), halts on the shuttle.
    const first = await runFSM(state, registry);
    assert.equal(first.directive.kind, "shuttle");
    const onDiskAfterSpawn = await withStateTransaction(projectDir, captureNow(), (tx) => loadState(tx));
    assert.equal(phaseStatusOf(onDiskAfterSpawn, "p1"), "in_progress", "p1 opens on entry");
    assert.equal(phaseStatusOf(onDiskAfterSpawn, "p2"), "pending", "p2 not yet entered");

    // Deliver the spawn result → drains the pending row, writes an
    // agent_records row for p1, advances the step.
    const arid =
      first.directive.kind === "shuttle" ? first.directive.spawn.agent_run_id : "";
    await withStateTransaction(projectDir, captureNow(), (tx) =>
      deliverContinue(tx, {
        input: { type: "agent-result", agent_run_id: arid, agent_output: "{}" },
        driver_state_id: "d-fixture",
        resolveOutputKind: () => "nonreview",
      }),
    );

    // Tick 2: leaving p1 (it has a record → completed), runs m2 in p2,
    // then finalize sweeps p2 (no record → skipped) and completes.
    const resumed = await withStateTransaction(projectDir, captureNow(), (tx) => loadState(tx));
    const second = await runFSM(resumed, registry);
    assert.equal(second.directive.kind, "complete");

    const final = await withStateTransaction(projectDir, captureNow(), (tx) => loadState(tx));
    assert.equal(phaseStatusOf(final, "p1"), "completed", "p1 completes when the flow leaves it");
    assert.equal(phaseStatusOf(final, "p2"), "skipped", "p2 ran no agents → skipped, with a reason");
    const p2 = final.phases.find((p) => p.name === "p2");
    assert.ok((p2?.skipped_reason?.length ?? 0) > 0, "skipped phase carries a reason");
    // A clean run is NOT all-skipped — at least one phase reads completed.
    assert.ok(final.phases.some((p) => p.status === "completed"), "a clean run shows a completed phase");
  });

  it("a phase with no agents is skipped (not completed) when the flow leaves it", async () => {
    const stages: Record<string, Stage> = {
      m1: { kind: "step", name: "m1", phase: "p1", position: "positional", effects: [] } as StepStage,
      m2: { kind: "step", name: "m2", phase: "p2", position: "positional", effects: [] } as StepStage,
      finalize: { kind: "finalize", name: "finalize" } as FinalizeStage,
    };
    const registry = buildRegistry({ stages, flow: ["m1", "m2", "finalize"], agents: [] });
    const now = await seedTwoPhase();
    const state = twoPhaseState(now);

    const out = await runFSM(state, registry);
    assert.equal(out.directive.kind, "complete");
    const final = await withStateTransaction(projectDir, captureNow(), (tx) => loadState(tx));
    // No agents ran in either phase → both skipped (with reasons), invariants hold.
    assert.equal(phaseStatusOf(final, "p1"), "skipped");
    assert.equal(phaseStatusOf(final, "p2"), "skipped");
  });
});

function phaseStatusOf(state: PipelineState, name: string): string | undefined {
  return state.phases.find((p) => p.name === name)?.status;
}

// ============================================================================
// W1 — auto-decided gates write a `gates` row
// ============================================================================

describe("runFSM — auto-gate row (W1)", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("an auto-approved gate writes a gates row with status + decided_by", async () => {
    const stages: Record<string, Stage> = {
      g1: {
        kind: "gate",
        name: "g1",
        phase: "p1",
        message: () => "ok?",
        valid_answers: () => ({ options: [] }),
      },
      finalize: { kind: "finalize", name: "finalize" },
    };
    const registry = buildRegistry({
      stages,
      flow: ["g1", "finalize"],
      policies: { human: autoApprovePolicyFactory },
    });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    const out = await runFSM(state, registry);
    assert.equal(out.directive.kind, "complete");

    const final = await withStateTransaction(projectDir, captureNow(), (tx) => loadState(tx));
    const gate = final.gates["g1"];
    assert.ok(gate, "auto-approved gate must leave a gates row");
    assert.equal(gate?.status, "auto-approved");
    assert.equal(gate?.decided_by, "auto-policy");
  });

  it("an auto-rejected gate writes a gates row with status auto-rejected", async () => {
    const stages: Record<string, Stage> = {
      g1: {
        kind: "gate",
        name: "g1",
        phase: "p1",
        message: () => "ok?",
        valid_answers: () => ({ options: [] }),
        // Advance on the auto-reject so the test does not spin the
        // walk-back loop — we only care that the row landed.
        on_resume: async () => ({ type: "advance" as const }),
      },
      finalize: { kind: "finalize", name: "finalize" },
    };
    const registry = buildRegistry({
      stages,
      flow: ["g1", "finalize"],
      policies: { human: autoRejectRevisePolicyFactory },
    });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    await runFSM(state, registry);

    const final = await withStateTransaction(projectDir, captureNow(), (tx) => loadState(tx));
    const gate = final.gates["g1"];
    assert.ok(gate, "auto-rejected gate must leave a gates row");
    assert.equal(gate?.status, "auto-rejected");
    assert.equal(gate?.decided_by, "auto-policy");
  });
});

// ============================================================================
// W2 — event-Step ops are mirrored to the in-memory snapshot
// ============================================================================

describe("runFSM — event-Step op mirror (W2)", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("an event-Step's set_decision is visible to a later same-pass stage", async () => {
    const stages: Record<string, Stage> = {
      // Fires on before-gate, sets a decision via the scratch façade.
      "evt-writer": {
        kind: "step",
        name: "evt-writer",
        position: "event",
        event: "before-gate",
        effects: [{ kind: "decisions.set", key: "evt_flag" }],
        run: async (_s, ctx) => {
          ctx.tx.set_decision?.("evt_flag", "set");
        },
      },
      g1: {
        kind: "gate",
        name: "g1",
        phase: "p1",
        message: () => "ok?",
        valid_answers: () => ({ options: [] }),
      },
      // Later positional stage: records what it saw of the event-Step write.
      reader: {
        kind: "step",
        name: "reader",
        phase: "p1",
        position: "positional",
        effects: [{ kind: "decisions.set", key: "reader_saw" }],
        run: async (_s, ctx) => {
          if (ctx.state.decisions["evt_flag"] === "set") {
            ctx.tx.set_decision?.("reader_saw", "yes");
          }
        },
      },
      finalize: { kind: "finalize", name: "finalize" },
    };
    const registry = buildRegistry({
      stages,
      flow: ["g1", "reader", "finalize"],
      policies: { human: autoApprovePolicyFactory },
    });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    await runFSM(state, registry);

    const final = await withStateTransaction(projectDir, captureNow(), (tx) => loadState(tx));
    // The before-gate event-Step set evt_flag; the reader stage one tick
    // later saw it (only possible if event-Step ops are mirrored onto the
    // in-memory snapshot — reverting the mirror leaves reader_saw unset).
    assert.equal(final.decisions["evt_flag"], "set");
    assert.equal(final.decisions["reader_saw"], "yes");
  });
});

// ============================================================================
// F1 — fanout iteration budget
// ============================================================================

describe("runFSM — fanout iteration budget (F1)", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("a fanout re-entered at its budget takes on_exhaustion (audit-only) instead of re-spawning", async () => {
    const stages: Record<string, Stage> = {
      f1: {
        kind: "fanout",
        name: "f1",
        phase: "p1",
        agents: ["a1"],
        iteration_budget: { kind: "attempt", max_iterations: 2, on_exhaustion: "audit-only" },
      } as FanoutStage,
      finalize: { kind: "finalize", name: "finalize" },
    };
    const registry = buildRegistry({
      stages,
      flow: ["f1", "finalize"],
      agents: [makeAgent("a1")],
    });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });
    // The fanout has already run its 2 allowed rounds.
    state.driver.scratch = { fanout_iter_f1: 2 };

    const out = await runFSM(state, registry);
    // audit-only → advance past the fanout (no shuttle-batch) to finalize.
    assert.equal(out.directive.kind, "complete");

    const final = await withStateTransaction(projectDir, captureNow(), (tx) => loadState(tx));
    assert.equal(final.pending_agents.length, 0, "exhausted fanout must not spawn");
  });

  it("an under-budget fanout increments its scratch counter and spawns", async () => {
    const stages: Record<string, Stage> = {
      f1: {
        kind: "fanout",
        name: "f1",
        phase: "p1",
        agents: ["a1"],
        iteration_budget: { kind: "attempt", max_iterations: 2, on_exhaustion: "audit-only" },
      } as FanoutStage,
    };
    const registry = buildRegistry({
      stages,
      flow: ["f1"],
      agents: [makeAgent("a1")],
    });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    const out = await runFSM(state, registry);
    assert.equal(out.directive.kind, "shuttle-batch");

    const final = await withStateTransaction(projectDir, captureNow(), (tx) => loadState(tx));
    assert.equal(
      final.driver.scratch["fanout_iter_f1"],
      1,
      "first fanout entry must bump the iteration counter to 1",
    );
  });

  it("a fanout with on_exhaustion=human halts at its budget instead of spawning", async () => {
    const stages: Record<string, Stage> = {
      f1: {
        kind: "fanout",
        name: "f1",
        phase: "p1",
        agents: ["a1"],
        iteration_budget: { kind: "attempt", max_iterations: 1, on_exhaustion: "human" },
      } as FanoutStage,
    };
    const registry = buildRegistry({
      stages,
      flow: ["f1"],
      agents: [makeAgent("a1")],
    });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });
    state.driver.scratch = { fanout_iter_f1: 1 };

    const out = await runFSM(state, registry);
    assert.equal(out.directive.kind, "error");
    if (out.directive.kind === "error") {
      assert.equal(out.directive.code, "FANOUT_ITERATION_BUDGET_EXHAUSTED");
    }
  });
});

// ============================================================================
// H1 — human answers honor the gate's on_resume
// ============================================================================

describe("runFSM — human gate on_resume (H1)", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  // Walk the FSM to its parked human gate, returning the issued event id.
  // runFSM advances step_index only in memory (the transport persists it
  // after the tick); mirror that here so the delivery path's loadState sees
  // the parked gate position, not the seeded 0.
  async function parkAtGate(registry: Registry, state: PipelineState): Promise<string> {
    const out = await runFSM(state, registry);
    assert.equal(out.directive.kind, "ask-user", "expected the gate to park for a human");
    await withStateTransaction(projectDir, captureNow(), (tx) =>
      tx.exec("UPDATE driver_state SET step_index = ? WHERE id = 1", [state.driver.step_index]),
    );
    return out.directive.kind === "ask-user" ? out.directive.gate_event_id : "";
  }

  function gateResume(): GateStage["on_resume"] {
    return async (_s, answer): Promise<StageResult> => {
      if (answer.decision === "accept") return { type: "advance" };
      if (answer.reject_intent === "abandon") {
        return {
          type: "complete",
          directive: { task_id: _s.task_id, verdict: "rejected", summary: "abandoned by human" },
        };
      }
      return { type: "walk_back_to", step: "plan-x", reason: "revise" };
    };
  }

  function buildGateRegistry(): Registry {
    const stages: Record<string, Stage> = {
      m1: { kind: "step", name: "m1", phase: "p1", position: "positional", effects: [] },
      "plan-x": { kind: "step", name: "plan-x", phase: "p1", position: "positional", effects: [] },
      "g-plan": {
        kind: "gate",
        name: "g-plan",
        phase: "p1",
        message: () => "Approve the plan?",
        valid_answers: () => ({ options: [] }),
        on_resume: gateResume(),
      },
      finalize: { kind: "finalize", name: "finalize" },
    };
    // Default human policy parks at the gate.
    return buildRegistry({ stages, flow: ["m1", "plan-x", "g-plan", "finalize"] });
  }

  it("human revise walks back (step_index regresses), NOT advances", async () => {
    const registry = buildGateRegistry();
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    const gid = await parkAtGate(registry, state);
    // Parked at g-plan (index 2).
    assert.equal(state.driver.step_index, 2);

    await withStateTransaction(projectDir, captureNow(), (tx) =>
      deliverContinue(tx, {
        input: { type: "user-answer", gate_event_id: gid, decision: "reject", reject_intent: "revise", message: "redo" },
        driver_state_id: state.driver_state_id,
        registry,
      }),
    );

    const after = await withStateTransaction(projectDir, captureNow(), (tx) => loadState(tx));
    // Walked back to plan-x (index 1) — NOT advanced to 3.
    assert.equal(after.driver.step_index, 1);
    assert.equal(after.driver.pending_user_answer, null);
    assert.equal(after.gates["g-plan"]?.status, "rejected");
  });

  it("human abandon completes rejected, NOT accepted", async () => {
    const registry = buildGateRegistry();
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    const gid = await parkAtGate(registry, state);

    await withStateTransaction(projectDir, captureNow(), (tx) =>
      deliverContinue(tx, {
        input: { type: "user-answer", gate_event_id: gid, decision: "reject", reject_intent: "abandon" },
        driver_state_id: state.driver_state_id,
        registry,
      }),
    );

    const after = await withStateTransaction(projectDir, captureNow(), (tx) => loadState(tx));
    assert.equal(after.status, "completed");
    assert.equal(after.verdict, "rejected");
    assert.notEqual(after.verdict, "accepted");
    // Phases swept terminal so INV_007 held on commit.
    assert.ok(after.phases.every((p) => p.status === "completed" || p.status === "skipped"));
  });

  it("human accept advances past the gate", async () => {
    const registry = buildGateRegistry();
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    const gid = await parkAtGate(registry, state);

    await withStateTransaction(projectDir, captureNow(), (tx) =>
      deliverContinue(tx, {
        input: { type: "user-answer", gate_event_id: gid, decision: "accept" },
        driver_state_id: state.driver_state_id,
        registry,
      }),
    );

    const after = await withStateTransaction(projectDir, captureNow(), (tx) => loadState(tx));
    assert.equal(after.driver.step_index, 3, "accept advances g-plan (index 2) → 3");
    assert.equal(after.gates["g-plan"]?.status, "approved");
  });

  it("replaying the same user-answer is a no-op (no double walk-back)", async () => {
    const registry = buildGateRegistry();
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });

    const gid = await parkAtGate(registry, state);

    const deliver = () =>
      withStateTransaction(projectDir, captureNow(), (tx) =>
        deliverContinue(tx, {
          input: { type: "user-answer", gate_event_id: gid, decision: "reject", reject_intent: "revise" },
          driver_state_id: state.driver_state_id,
          registry,
        }),
      );
    await deliver();
    const afterFirst = await withStateTransaction(projectDir, captureNow(), (tx) => loadState(tx));
    await deliver(); // replay — ledger row already present
    const afterReplay = await withStateTransaction(projectDir, captureNow(), (tx) => loadState(tx));

    assert.equal(afterFirst.driver.step_index, 1);
    assert.equal(afterReplay.driver.step_index, 1, "replay must not walk back a second time");
  });
});

// ============================================================================
// Conditional spawn — SpawnStage.when gates the launch on a generic predicate
// ============================================================================

// Insert findings rows directly so the stage tick's pre-materialized
// findings accessor surfaces them to the predicate. Positional/code
// fields stay NULL — the predicate must decide without them.
async function seedFindingRows(
  projectDir: string,
  now: NowToken,
  rows: Array<{
    id: string;
    agent: string;
    iteration: number;
    phase: string;
    severity: "blocking" | "warn" | "info";
    category: string;
    status: "open" | "fixed" | "accepted_by_human" | "dismissed";
    summary: string;
  }>,
): Promise<void> {
  await withStateTransaction(projectDir, now, async (tx) => {
    for (const r of rows) {
      await tx.exec(
        "INSERT INTO findings (id, task_id, agent, iteration, phase, file, " +
          "line_start, line_end, severity, category, proposed_new_category, " +
          "pattern_id, summary, evidence_excerpt, suggested_fix, status, " +
          "ref_rule_id, recorded_at) " +
          "VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL, NULL, ?, NULL, NULL, ?, NULL, ?)",
        [
          r.id,
          "t-2026-05-28-fixture",
          r.agent,
          r.iteration,
          r.phase,
          r.severity,
          r.category,
          r.summary,
          r.status,
          now,
        ],
      );
    }
  });
}

// A reviewer verdict row for the in-memory snapshot (verdict-spread input).
function mkVerdict(
  agent: string,
  verdict: "APPROVE" | "REQUEST_CHANGES",
  now: NowToken,
): PipelineState["agent_verdicts"][number] {
  return {
    phase: "p1",
    agent,
    iteration: 1,
    verdict,
    summary_line: null,
    blocking_issues: verdict === "APPROVE" ? 0 : 1,
    warn_issues: 0,
    info_issues: 0,
    categories_seen: [],
    recorded_at: now,
  };
}

// The escalation predicate. Generic over the outcome subset only:
//   (a) an OPEN BLOCKING finding exists in the review phase, AND
//   (b) the reviewers SPLIT — ≥2 distinct verdict values on that phase.
// It reads finding severity/status + (phase) provenance via the accessor
// and verdict values off the view; it never touches a finding's
// file/line/pattern_id (those are NULL on the seeded rows, and the
// predicate still decides correctly — that is the generic-subset proof).
function escalateWhen(state: BundleStateView, ctx: ConditionalSpawnContext): boolean {
  const blocking = ctx.findings.query({
    phase: "p1",
    severity: ["blocking"],
    status: ["open"],
  });
  if (blocking.length === 0) return false;
  const verdicts = new Set(
    state.agent_verdicts.filter((v) => v.phase === "p1").map((v) => v.verdict),
  );
  return verdicts.size >= 2;
}

describe("runFSM — conditional spawn (SpawnStage.when)", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("spawns the verifier when the predicate holds (blocking finding + split verdicts)", async () => {
    const stages: Record<string, Stage> = {
      "verify-spawn": {
        kind: "spawn",
        name: "verify-spawn",
        phase: "p1",
        agent: "verifier",
        when: escalateWhen,
      } as SpawnStage,
    };
    const registry = buildRegistry({
      stages,
      flow: ["verify-spawn"],
      agents: [makeAgent("verifier")],
    });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    await seedFindingRows(projectDir, now, [
      {
        id: "f-2026-06-01-aaaaaa",
        agent: "r1",
        iteration: 1,
        phase: "p1",
        severity: "blocking",
        category: "behavior",
        status: "open",
        summary: "claims a runtime outcome",
      },
    ]);
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });
    state.agent_verdicts = [
      mkVerdict("r1", "REQUEST_CHANGES", now),
      mkVerdict("r2", "APPROVE", now),
    ];

    const out = await runFSM(state, registry);
    assert.equal(out.directive.kind, "shuttle");
    if (out.directive.kind === "shuttle") {
      assert.equal(out.directive.spawn.agent, "verifier");
      assert.ok(out.directive.spawn.agent_run_id.startsWith("ar-"));
      assert.equal(out.directive.spawn.phase, "p1");
    }
    const after = await withStateTransaction(projectDir, captureNow(), (tx) =>
      loadState(tx),
    );
    assert.equal(after.pending_agents.length, 1);
    assert.equal(after.pending_agents[0]?.agent, "verifier");
  });

  it("advances without spawning when the verdicts agree (no spread)", async () => {
    const stages: Record<string, Stage> = {
      "verify-spawn": {
        kind: "spawn",
        name: "verify-spawn",
        phase: "p1",
        agent: "verifier",
        when: escalateWhen,
      } as SpawnStage,
      g1: {
        kind: "gate",
        name: "g1",
        phase: "p1",
        message: () => "proceed?",
        valid_answers: () => ({ options: [] }),
      },
    };
    const registry = buildRegistry({
      stages,
      flow: ["verify-spawn", "g1"],
      agents: [makeAgent("verifier")],
    });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    await seedFindingRows(projectDir, now, [
      {
        id: "f-2026-06-01-bbbbbb",
        agent: "r1",
        iteration: 1,
        phase: "p1",
        severity: "blocking",
        category: "behavior",
        status: "open",
        summary: "claims a runtime outcome",
      },
    ]);
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });
    state.agent_verdicts = [
      mkVerdict("r1", "APPROVE", now),
      mkVerdict("r2", "APPROVE", now),
    ];

    const out = await runFSM(state, registry);
    // The spawn advanced (verdicts agree → no escalation); the human gate halts.
    assert.equal(out.directive.kind, "ask-user");
    const after = await withStateTransaction(projectDir, captureNow(), (tx) =>
      loadState(tx),
    );
    assert.equal(after.pending_agents.length, 0);
  });

  it("advances without spawning when no blocking finding exists (split verdicts alone insufficient)", async () => {
    const stages: Record<string, Stage> = {
      "verify-spawn": {
        kind: "spawn",
        name: "verify-spawn",
        phase: "p1",
        agent: "verifier",
        when: escalateWhen,
      } as SpawnStage,
      g1: {
        kind: "gate",
        name: "g1",
        phase: "p1",
        message: () => "proceed?",
        valid_answers: () => ({ options: [] }),
      },
    };
    const registry = buildRegistry({
      stages,
      flow: ["verify-spawn", "g1"],
      agents: [makeAgent("verifier")],
    });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    // Only a non-blocking finding — the predicate's (a) clause fails.
    await seedFindingRows(projectDir, now, [
      {
        id: "f-2026-06-01-cccccc",
        agent: "r1",
        iteration: 1,
        phase: "p1",
        severity: "warn",
        category: "style",
        status: "open",
        summary: "nit",
      },
    ]);
    const state = buildInMemoryState(projectDir, now, { flow_name: "default" });
    state.agent_verdicts = [
      mkVerdict("r1", "REQUEST_CHANGES", now),
      mkVerdict("r2", "APPROVE", now),
    ];

    const out = await runFSM(state, registry);
    assert.equal(out.directive.kind, "ask-user");
    const after = await withStateTransaction(projectDir, captureNow(), (tx) =>
      loadState(tx),
    );
    assert.equal(after.pending_agents.length, 0);
  });

  it("re-running the same conditional-spawn tick dedups (no second pending row)", async () => {
    const stages: Record<string, Stage> = {
      "verify-spawn": {
        kind: "spawn",
        name: "verify-spawn",
        phase: "p1",
        agent: "verifier",
        when: escalateWhen,
      } as SpawnStage,
    };
    const registry = buildRegistry({
      stages,
      flow: ["verify-spawn"],
      agents: [makeAgent("verifier")],
    });
    const now = await seedBaseline(projectDir, { flow_name: "default" });
    await seedFindingRows(projectDir, now, [
      {
        id: "f-2026-06-01-dddddd",
        agent: "r1",
        iteration: 1,
        phase: "p1",
        severity: "blocking",
        category: "behavior",
        status: "open",
        summary: "claims a runtime outcome",
      },
    ]);
    const verdicts = [mkVerdict("r1", "REQUEST_CHANGES", now), mkVerdict("r2", "APPROVE", now)];

    // First tick: predicate true → shuttle + one pending_agents row.
    const first = buildInMemoryState(projectDir, now, { flow_name: "default" });
    first.agent_verdicts = verdicts;
    const out1 = await runFSM(first, registry);
    assert.equal(out1.directive.kind, "shuttle");

    // Re-deliver the same tick under the SAME now (the spawn never
    // advanced — a shuttle parks step_index). The predicate re-derives the
    // same verdict deterministically; SpawnGuard refuses the duplicate
    // launch so no second pending row is written. agent_run_id is a fresh
    // UUID by design — dedup is the (agent, phase, now-window) guard, the
    // same mechanism every ordinary spawn relies on.
    const second = buildInMemoryState(projectDir, now, { flow_name: "default" });
    second.agent_verdicts = verdicts;
    await assert.rejects(
      runFSM(second, registry),
      (err: unknown) => err instanceof KernelError && err.code === "DUPLICATE_SPAWN",
    );
    const after = await withStateTransaction(projectDir, captureNow(), (tx) =>
      loadState(tx),
    );
    assert.equal(after.pending_agents.length, 1, "dedup: exactly one launch survives");
  });
});

// Suppress unused-import warnings for fixture-side types that the
// type system needs for the test fixtures above but the runtime
// path doesn't reference directly.
void ({} as { intent?: ProviderShuttleIntent; ctx?: StageContext; res?: StageResult; he?: HookEvent; ans?: UserAnswer; ke?: KernelError; ops?: BundleOp[] });
