// A bundle whose gate roles are entirely its own — none of the three
// kernel-shipped role literals — must type-check and drive to finalize through
// the TICK PATH. The bundle literal below is the regression guard: its
// `default_gate_policies` names NONE of classify/plan/final, which compiles
// only because the map type is `Partial<Record<GateRole, PolicyName>>`.
// Narrowing it back to a total `Record` re-introduces the "missing properties:
// classify, plan, final" error and this file stops compiling.
//
// The registry here is HAND-BUILT — no loadBundle, no build-time loader — so
// this proves the kernel's gate dispatcher is gate-role-generic at tick time
// without depending on `@loomfsm/loader`. (That the loader CASCADE also accepts
// such a bundle is proven on a fabricated roster in the loader's own suite.)

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { runFSM } from "../src/fsm.js";
import { _resetInvariantsForTest } from "../src/invariants.js";
import { buildPolicyFactoryRegistry } from "../src/policies/index.js";
import {
  captureNow,
  closeDb,
  loadState,
  withStateTransaction,
} from "../src/state.js";
import { buildVocabularies } from "../src/vocabularies.js";
import type { Bundle } from "../src/types/bundle.js";
import type { NowToken } from "../src/types/now.js";
import type { MCPClientPlugin, Stage } from "../src/types/plugins.js";
import type { LLMProvider } from "../src/types/provider.js";
import type { ProviderRegistry, Registry } from "../src/types/registry.js";
import type { PipelineState } from "../src/types/state.js";

const BUNDLE_NAME = "gate-genericity-fixture";

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "loom-gate-genericity-"));
}

function cleanup(projectDir: string): void {
  try {
    closeDb(projectDir);
  } catch {
    /* may have already closed */
  }
  rmSync(projectDir, { recursive: true, force: true });
}

function stubProvider(): LLMProvider {
  return {
    name: "stub",
    capabilities: { execution: "shuttle", idempotent_spawn: true, reports_usage: true },
    async spawn() {
      throw new Error("stub — spawn must not run in this test");
    },
  };
}

// The non-code bundle. Its roles are `scope` / `consult` / `spec-approval`;
// the gate routes to `spec-approval`, resolved via the kernel stock
// `on-blockers` posture (auto-approves on a clean findings state). No
// baseline role appears anywhere in the gate-policy map.
function makeNonCodeBundle(): Bundle {
  return {
    name: BUNDLE_NAME,
    version: "0.0.0",
    description: "non-code gate-role genericity fixture",
    phases: ["review"],
    default_flow: "default",
    default_gate_policies: {
      scope: "human",
      consult: "human",
      "spec-approval": "on-blockers",
    },
    agents: [],
    stages: {
      "approval-gate": {
        kind: "gate",
        name: "approval-gate",
        phase: "review",
        message: () => "approve?",
        valid_answers: () => ({ options: [] }),
      },
      finalize: { kind: "finalize", name: "finalize" },
    },
    flows: { default: ["approval-gate", "finalize"] },
    hooks: [],
    invariants: [],
    gate_roles: { "approval-gate": "spec-approval" },
    extends_vocab: { gate_roles_extra: ["scope", "consult", "spec-approval"] },
  };
}

// Hand-assemble the Registry the kernel ticks — the tick-time subset the gate +
// finalize stages consult. No loader, no installed_extensions row: runFSM reads
// the passed state and registry, nothing else.
function buildRegistry(bundle: Bundle): Registry {
  const stages = new Map<string, Stage>(Object.entries(bundle.stages));
  const flows = new Map<string, string[]>(Object.entries(bundle.flows));
  const providers: ProviderRegistry = {
    all: [stubProvider()],
    resolve() {
      throw new Error("resolve must not run — this flow spawns no agent");
    },
    health_check_all: Promise.resolve([]),
  };
  return {
    bundle,
    agents: new Map(),
    stages,
    flows,
    hooks: [],
    invariants: bundle.invariants,
    mcp_clients: new Map<string, MCPClientPlugin>(),
    providers,
    policyFactories: buildPolicyFactoryRegistry(bundle),
    vocabularies: buildVocabularies(bundle),
  };
}

async function seedState(projectDir: string, now: NowToken): Promise<void> {
  await withStateTransaction(projectDir, now, async (tx) => {
    await tx.exec(
      "INSERT INTO pipeline_state (id, schema_version, project_dir, bundle, " +
        "task, task_id, driver_state_id, status, verdict, started_at, " +
        "decisions, bundle_state) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "3.0.0",
        projectDir,
        BUNDLE_NAME,
        "gate genericity fixture",
        "t-2026-06-01-genericity",
        "d-genericity",
        "in_progress",
        null,
        now,
        "{}",
        null,
      ],
    );
    await tx.exec(
      "INSERT INTO driver_state (id, flow_name, step_index, complete) " +
        "VALUES (1, 'default', 0, 0)",
    );
    await tx.exec("INSERT INTO pipeline_counters (id) VALUES (1)");
    await tx.exec(
      "INSERT INTO phases (name, status, skipped_reason, updated_at) " +
        "VALUES ('review', 'pending', NULL, ?)",
      [now],
    );
  });
}

function buildState(projectDir: string, now: NowToken): PipelineState {
  return {
    schema_version: "3.0.0",
    task_id: "t-2026-06-01-genericity",
    driver_state_id: "d-genericity",
    project_dir: projectDir,
    bundle: BUNDLE_NAME,
    task: "gate genericity fixture",
    task_short: null,
    owner_id: null,
    status: "in_progress",
    verdict: null,
    started_at: now,
    ended_at: null,
    // Operator-override tier empty: every role resolves through the
    // bundle default, exercising the partial map at runtime.
    gate_policies: {},
    decisions: {},
    bundle_state: null,
    pipeline_violation: null,
    force_used: false,
    agents_count: 0,
    gate_revisions: {},
    gate_auto_rejections: {},
    files_created: [],
    files_modified: [],
    total_tokens_in: 0,
    total_tokens_out: 0,
    total_tokens_cached: 0,
    driver: {
      flow_name: "default",
      step_index: 0,
      complete: false,
      pending_user_answer: null,
      scratch: {},
    },
    phases: [
      {
        name: "review",
        status: "pending",
        skipped_reason: null,
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

describe("gate-role genericity — a non-code bundle drives the tick path with no baseline roles", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("drives to finalize through a gate routed to a non-baseline role", async () => {
    const now = captureNow();
    const registry = buildRegistry(makeNonCodeBundle());
    await seedState(projectDir, now);
    const state = buildState(projectDir, now);

    const out = await runFSM(state, registry);
    assert.equal(out.directive.kind, "complete");
    if (out.directive.kind === "complete") {
      assert.equal(out.directive.verdict, "accepted");
    }

    // The non-baseline role resolved its bundle-default posture and the
    // clean findings state auto-approved the gate — proving the partial
    // map drives end-to-end through the dispatcher's three-tier fallback.
    const persisted = await withStateTransaction(projectDir, captureNow(), (tx) =>
      loadState(tx),
    );
    assert.equal(persisted.gates["approval-gate"]?.status, "auto-approved");
  });
});
