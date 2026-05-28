import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { buildStageContext } from "../src/fsm.js";
import { _resetInvariantsForTest } from "../src/invariants.js";
import {
  captureNow,
  closeDb,
  KernelError,
  withStateTransaction,
} from "../src/state.js";
import { buildVocabularies } from "../src/vocabularies.js";
import type { Bundle } from "../src/types/bundle.js";
import type { NowToken } from "../src/types/now.js";
import type { Policy, PolicyName } from "../src/types/policy.js";
import type { LLMProvider } from "../src/types/provider.js";
import type { Registry } from "../src/types/registry.js";
import type { GateRole } from "../src/types/row-types.js";
import type { PipelineState } from "../src/types/state.js";

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "loom-scratch-tx-read-"));
}

function cleanup(projectDir: string): void {
  try {
    closeDb(projectDir);
  } catch {
    /* may have already closed */
  }
  rmSync(projectDir, { recursive: true, force: true });
}

function humanFactory(): Policy {
  return () => ({ type: "human-required", reason: "test" });
}

function buildRegistry(): Registry {
  const stubProvider: LLMProvider = {
    name: "stub",
    capabilities: {
      execution: "shuttle",
      idempotent_spawn: true,
      reports_usage: true,
    },
    async spawn() {
      throw new Error("stub provider — spawn must not run in this test");
    },
  };
  const bundle: Bundle = {
    name: "stub-bundle",
    version: "0.0.1",
    description: "scratch-tx read fixture",
    phases: ["p1"],
    default_flow: "default",
    default_gate_policies: { plan: "human" } as Record<GateRole, PolicyName>,
    gate_roles: {},
    agents: [],
    stages: {},
    flows: { default: [] },
    hooks: [],
    invariants: [],
  };
  return {
    bundle,
    agents: new Map(),
    stages: new Map(),
    flows: new Map([["default", []]]),
    hooks: [],
    invariants: [],
    mcp_clients: new Map(),
    providers: {
      resolve: () => stubProvider,
      all: [stubProvider],
      health_check_all: Promise.resolve([{ name: "stub", healthy: true }]),
    },
    policyFactories: new Map<PolicyName, () => Policy>([["human", humanFactory]]),
    vocabularies: buildVocabularies(bundle),
  };
}

async function seedBaseline(projectDir: string): Promise<NowToken> {
  const now = captureNow();
  await withStateTransaction(projectDir, now, async (tx) => {
    await tx.exec(
      "INSERT INTO pipeline_state (id, schema_version, project_dir, bundle, " +
        "task, task_id, driver_state_id, status, verdict, started_at) " +
        "VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "3.0.0",
        projectDir,
        "stub-bundle",
        "scratch-tx read fixture",
        "t-2026-05-28-scratch-tx",
        "d-scratch-tx",
        "in_progress",
        null,
        now,
      ],
    );
    await tx.exec(
      "INSERT INTO driver_state (id, flow_name, step_index, complete) " +
        "VALUES (1, ?, 0, 0)",
      ["default"],
    );
    await tx.exec("INSERT INTO pipeline_counters (id) VALUES (1)");
    await tx.exec(
      "INSERT INTO phases (name, status, skipped_reason, updated_at) " +
        "VALUES ('p1', 'pending', NULL, ?)",
      [now],
    );
  });
  return now;
}

function buildInMemoryState(projectDir: string, now: NowToken): PipelineState {
  return {
    schema_version: "3.0.0",
    task_id: "t-2026-05-28-scratch-tx",
    driver_state_id: "d-scratch-tx",
    project_dir: projectDir,
    bundle: "stub-bundle",
    task: "scratch-tx read fixture",
    task_short: null,
    owner_id: null,
    status: "in_progress",
    verdict: null,
    started_at: now,
    ended_at: null,
    gate_policies: {} as Record<GateRole, PolicyName>,
    decisions: {},
    bundle_state: null,
    stack: null,
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
      flow_name: "default",
      step_index: 0,
      complete: false,
      pending_user_answer: null,
      scratch: {},
    },
    phases: [
      {
        name: "p1",
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

describe("BundleScratchTx.read — fail-loud heavy accessors", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("pipeline_state() returns the loaded snapshot", async () => {
    const now = await seedBaseline(projectDir);
    const registry = buildRegistry();
    const state = buildInMemoryState(projectDir, now);
    const checkNow = captureNow();

    const snapshot = await withStateTransaction(projectDir, checkNow, async (tx) => {
      const { ctx } = await buildStageContext(state, registry, tx);
      return ctx.tx.read.pipeline_state();
    });

    assert.equal(snapshot.task_id, "t-2026-05-28-scratch-tx");
    assert.equal(snapshot.bundle, "stub-bundle");
  });

  for (const accessor of ["findings", "agent_records", "audit", "bundle_table"] as const) {
    it(`${accessor}() throws KernelError{READ_NOT_WIRED}`, async () => {
      const now = await seedBaseline(projectDir);
      const registry = buildRegistry();
      const state = buildInMemoryState(projectDir, now);
      const checkNow = captureNow();

      let captured: unknown = null;
      try {
        await withStateTransaction(projectDir, checkNow, async (tx) => {
          const { ctx } = await buildStageContext(state, registry, tx);
          if (accessor === "bundle_table") {
            ctx.tx.read.bundle_table("any_table");
          } else {
            ctx.tx.read[accessor]();
          }
        });
      } catch (err) {
        captured = err;
      }

      assert.ok(captured instanceof KernelError, `expected KernelError, got ${String(captured)}`);
      const kerr = captured as KernelError;
      assert.equal(kerr.code, "READ_NOT_WIRED");
      assert.equal(
        (kerr.detail as { accessor: string } | undefined)?.accessor,
        accessor,
      );
    });
  }
});
