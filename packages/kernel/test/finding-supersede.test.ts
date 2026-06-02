import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { buildStageContext } from "../src/fsm.js";
import { deliverContinue } from "../src/lib/deliver-continue.js";
import { materializeAccessSnapshot } from "../src/lib/access-snapshots.js";
import {
  readPhaseIter,
  supersedeFindingsOnWalkBack,
} from "../src/lib/supersede-findings.js";
import { policies, buildPolicyContext } from "../src/policies/index.js";
import { _resetInvariantsForTest } from "../src/invariants.js";
import { buildVocabularies } from "../src/vocabularies.js";
import {
  KernelError,
  captureNow,
  closeDb,
  loadState,
  openDb,
  withStateTransaction,
} from "../src/state.js";
import type { Bundle } from "../src/types/bundle.js";
import type { NowToken } from "../src/types/now.js";
import type { Stage } from "../src/types/plugins.js";
import type { Policy, PolicyName } from "../src/types/policy.js";
import type { LLMProvider } from "../src/types/provider.js";
import type { Registry } from "../src/types/registry.js";
import type { GateRole } from "../src/types/row-types.js";
import type { BundleStateView, PipelineState } from "../src/types/state.js";

const NOW = "2026-06-01T10:00:00.000Z" as NowToken;
const DRIVER = "d-supersede";

// A three-stage planning flow, all phase "planning" — a gate-plan rejection
// walks the flow back to "plan", re-running every planning stage.
const PLANNING_FLOW = ["plan", "plan-review", "gate-plan"];
function planningStages(): Map<string, Stage> {
  return new Map<string, Stage>([
    ["plan", { kind: "spawn", name: "plan", phase: "planning", agent: "planner" }],
    ["plan-review", { kind: "fanout", name: "plan-review", phase: "planning", agents: [] }],
    [
      "gate-plan",
      {
        kind: "gate",
        name: "gate-plan",
        phase: "planning",
        message: () => "approve the plan?",
        valid_answers: () => ({ options: [] }),
      },
    ],
  ]);
}

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "loom-supersede-"));
}

function cleanup(dir: string): void {
  try {
    closeDb(dir);
  } catch {
    /* may already be closed */
  }
  rmSync(dir, { recursive: true, force: true });
}

interface SeedOpts {
  scratch?: string;
  verdict?: string | null;
  phaseStatus?: "pending" | "in_progress" | "completed" | "skipped";
  pending?: { agent_run_id: string; agent: string; phase: string };
}

async function seed(dir: string, opts: SeedOpts = {}): Promise<void> {
  const scratch = opts.scratch ?? "{}";
  const verdict = opts.verdict ?? null;
  const phaseStatus = opts.phaseStatus ?? "pending";
  const reason = phaseStatus === "skipped" ? "swept for fixture" : null;
  await withStateTransaction(dir, NOW, async (tx) => {
    await tx.exec(
      "INSERT INTO pipeline_state (id, schema_version, project_dir, bundle, task_id, " +
        "task, driver_state_id, status, verdict, started_at, gate_policies, decisions) " +
        "VALUES (1, '3.0.0', ?, 'code-fixture', 't-2026-06-01-sup', 'seeded task', ?, " +
        "'in_progress', ?, ?, '{}', '{}')",
      [dir, DRIVER, verdict, NOW],
    );
    await tx.exec(
      "INSERT INTO driver_state (id, flow_name, step_index, complete, pending_user_answer, scratch) " +
        "VALUES (1, 'planning', 2, 0, NULL, ?)",
      [scratch],
    );
    await tx.exec("INSERT INTO pipeline_counters (id) VALUES (1)");
    await tx.exec(
      "INSERT INTO phases (name, status, skipped_reason, updated_at) VALUES ('planning', ?, ?, ?)",
      [phaseStatus, reason, NOW],
    );
    if (opts.pending) {
      await tx.exec(
        "INSERT INTO pending_agents (agent_run_id, agent, phase, model, started_at) " +
          "VALUES (?, ?, ?, NULL, ?)",
        [opts.pending.agent_run_id, opts.pending.agent, opts.pending.phase, NOW],
      );
    }
  });
}

async function insertBlocking(
  dir: string,
  opts: { id: string; iteration: number; status?: string; phase?: string },
): Promise<void> {
  await withStateTransaction(dir, NOW, async (tx) => {
    await tx.exec(
      "INSERT INTO findings (id, task_id, agent, iteration, phase, file, line_start, " +
        "line_end, severity, category, proposed_new_category, pattern_id, summary, " +
        "evidence_excerpt, suggested_fix, status, ref_rule_id, recorded_at) " +
        "VALUES (?, 't-2026-06-01-sup', 'logic-reviewer', ?, ?, NULL, NULL, NULL, " +
        "'blocking', 'correctness', NULL, NULL, 'plan is wrong', NULL, NULL, ?, NULL, ?)",
      [opts.id, opts.iteration, opts.phase ?? "planning", opts.status ?? "open", NOW],
    );
  });
}

async function countBlocking(dir: string, phase: string): Promise<number> {
  return withStateTransaction(dir, NOW, async (tx) => {
    const snap = await materializeAccessSnapshot(tx);
    return snap.findings.countBlocking({ phase });
  });
}

async function readSupersede(dir: string, id: string): Promise<number | null> {
  const row = await withStateTransaction(dir, NOW, (tx) =>
    tx.queryRow<{ superseded_by_iteration: number | null }>(
      "SELECT superseded_by_iteration FROM findings WHERE id = ?",
      [id],
    ),
  );
  return row?.superseded_by_iteration ?? null;
}

describe("finding supersede — walk-back resolver", () => {
  let dir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    dir = freshProject();
    openDb(dir);
  });
  afterEach(() => cleanup(dir));

  it("retires the prior round's live blocker and bumps the phase counter", async () => {
    await seed(dir);
    await insertBlocking(dir, { id: "f-plan-1", iteration: 1 });

    // Before the walk-back the blocker is live and counts against the gate.
    assert.equal(await countBlocking(dir, "planning"), 1);

    const merged = await withStateTransaction(dir, NOW, (tx) =>
      supersedeFindingsOnWalkBack(tx, {
        flow: PLANNING_FLOW,
        stages: planningStages(),
        targetIndex: 0,
        currentIndex: 2,
        scratch: {},
      }),
    );

    // The finding is linked to round 2; the counter advanced. Reverting the
    // UPDATE in the resolver leaves superseded_by_iteration NULL → the
    // count below stays 1 → this assertion reddens.
    assert.equal(await readSupersede(dir, "f-plan-1"), 2);
    assert.equal(readPhaseIter(merged, "planning"), 2);
    assert.equal(await countBlocking(dir, "planning"), 0);
  });

  it("on-blockers escalates on the live blocker, auto-resolves once superseded", async () => {
    await seed(dir);
    await insertBlocking(dir, { id: "f-plan-1", iteration: 1 });

    const onBlockers: Policy = policies.onBlockers();

    // With the live blocker present the gate policy pulls in a human.
    const before = await withStateTransaction(dir, NOW, async (tx) => {
      const { ctx } = await buildStageContext(inMemoryState(dir), buildRegistry(), tx);
      return onBlockers({} as BundleStateView, "plan" as GateRole, buildPolicyContext(ctx));
    });
    assert.equal(before.type, "human-required");

    // Replan: supersede the planning round.
    await withStateTransaction(dir, NOW, (tx) =>
      supersedeFindingsOnWalkBack(tx, {
        flow: PLANNING_FLOW,
        stages: planningStages(),
        targetIndex: 0,
        currentIndex: 2,
        scratch: {},
      }),
    );

    // Same gate, clean live set → no human round-trip.
    const after = await withStateTransaction(dir, NOW, async (tx) => {
      const { ctx } = await buildStageContext(inMemoryState(dir), buildRegistry(), tx);
      return onBlockers({} as BundleStateView, "plan" as GateRole, buildPolicyContext(ctx));
    });
    assert.equal(after.type, "auto-approve");
  });
});

describe("finding supersede — countBlocking liveness", () => {
  let dir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    dir = freshProject();
    openDb(dir);
  });
  afterEach(() => cleanup(dir));

  it("excludes a superseded blocker and a non-open blocker", async () => {
    await seed(dir);
    await insertBlocking(dir, { id: "f-live", iteration: 2 });
    await insertBlocking(dir, { id: "f-fixed", iteration: 2, status: "fixed" });
    await insertBlocking(dir, { id: "f-old", iteration: 1 });
    // Retire the prior round directly.
    await withStateTransaction(dir, NOW, (tx) =>
      tx.exec("UPDATE findings SET superseded_by_iteration = 2 WHERE id = 'f-old'"),
    );

    // Only `f-live` is open + non-superseded.
    assert.equal(await countBlocking(dir, "planning"), 1);
  });
});

describe("finding supersede — kernel-stamped iteration", () => {
  let dir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    dir = freshProject();
    openDb(dir);
  });
  afterEach(() => cleanup(dir));

  // A reviewer header self-reporting a bogus iteration; the kernel must
  // stamp the row from the per-phase counter instead.
  const reviewerOutput = JSON.stringify({
    verdict: "REQUEST_CHANGES",
    findings: [
      {
        severity: "blocking",
        iteration: 99,
        category: "correctness",
        summary: "still broken",
      },
    ],
  });

  async function deliverReviewer(arid: string): Promise<number> {
    await withStateTransaction(dir, NOW, (tx) =>
      deliverContinue(tx, {
        input: { type: "agent-result", agent_run_id: arid, agent_output: reviewerOutput },
        driver_state_id: DRIVER,
        resolveOutputKind: () => "reviewer",
      }),
    );
    const row = await withStateTransaction(dir, NOW, (tx) =>
      tx.queryRow<{ iteration: number }>(
        "SELECT iteration FROM findings ORDER BY id DESC LIMIT 1",
      ),
    );
    return Number(row?.iteration);
  }

  it("stamps round 1 when the per-phase counter is unset", async () => {
    await seed(dir, {
      pending: { agent_run_id: "ar-r1", agent: "logic-reviewer", phase: "planning" },
    });
    // Self-reported iteration 99 is ignored; absent counter ⇒ round 1.
    assert.equal(await deliverReviewer("ar-r1"), 1);
  });

  it("stamps the bumped round after a walk-back set the counter", async () => {
    await seed(dir, {
      scratch: JSON.stringify({ phase_iter_planning: 2 }),
      pending: { agent_run_id: "ar-r2", agent: "logic-reviewer", phase: "planning" },
    });
    // Counter says round 2 — the row carries 2, not the agent's 99. Revert
    // the kernel-stamp (use finding.iteration) and this returns 99 → reddens.
    assert.equal(await deliverReviewer("ar-r2"), 2);
  });
});

describe("finding supersede — acceptance veto on a real commit", () => {
  let dir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    dir = freshProject();
    openDb(dir);
  });
  afterEach(() => cleanup(dir));

  it("refuses an accepted verdict while a live blocker stands; passes once superseded", async () => {
    // Phase swept terminal so only the acceptance veto can object; the
    // blocker is seeded while the verdict is still null (inv008 dormant).
    await seed(dir, { phaseStatus: "skipped" });
    await insertBlocking(dir, { id: "f-impl-1", iteration: 1 });

    // Flipping the verdict to accepted while the blocker is live trips
    // INV_008 on commit and rolls the whole tx back. Reverting inv008 to a
    // no-op makes this NOT reject → reddens.
    await assert.rejects(
      withStateTransaction(dir, NOW, (tx) =>
        tx.exec("UPDATE pipeline_state SET verdict = 'accepted' WHERE id = 1"),
      ),
      (err: unknown) =>
        err instanceof KernelError &&
        err.code === "INVARIANT_VIOLATION" &&
        JSON.stringify(err.detail).includes("INV_008"),
    );
    const stillOpen = await withStateTransaction(dir, NOW, (tx) => loadState(tx));
    assert.equal(stillOpen.verdict, null);

    // Retire the blocker (a replan resolved it), then the same verdict
    // commit goes through.
    await withStateTransaction(dir, NOW, (tx) =>
      tx.exec("UPDATE findings SET superseded_by_iteration = 2 WHERE id = 'f-impl-1'"),
    );
    await withStateTransaction(dir, NOW, (tx) =>
      tx.exec("UPDATE pipeline_state SET verdict = 'accepted' WHERE id = 1"),
    );
    const accepted = await withStateTransaction(dir, NOW, (tx) => loadState(tx));
    assert.equal(accepted.verdict, "accepted");
  });
});

// ============================================================================
// Minimal registry / state fixtures for the policy-layer assertions
// ============================================================================

function buildRegistry(): Registry {
  const stubProvider: LLMProvider = {
    name: "stub",
    capabilities: { execution: "shuttle", idempotent_spawn: true, reports_usage: true },
    async spawn() {
      throw new Error("stub provider — spawn must not run");
    },
  };
  const bundle: Bundle = {
    name: "code-fixture",
    version: "0.0.1",
    description: "supersede fixture",
    phases: ["planning"],
    default_flow: "planning",
    default_gate_policies: {} as Record<GateRole, PolicyName>,
    gate_roles: {},
    agents: [],
    stages: {},
    flows: { planning: PLANNING_FLOW },
    hooks: [],
    invariants: [],
  };
  return {
    bundle,
    agents: new Map(),
    stages: new Map(),
    flows: new Map([["planning", PLANNING_FLOW]]),
    hooks: [],
    invariants: [],
    mcp_clients: new Map(),
    providers: {
      resolve: () => stubProvider,
      all: [stubProvider],
      health_check_all: Promise.resolve([{ name: "stub", healthy: true }]),
    },
    policyFactories: new Map<PolicyName, () => Policy>(),
    vocabularies: buildVocabularies(bundle),
  };
}

function inMemoryState(dir: string): PipelineState {
  return {
    schema_version: "3.0.0",
    task_id: "t-2026-06-01-sup",
    driver_state_id: DRIVER,
    project_dir: dir,
    bundle: "code-fixture",
    task: "seeded task",
    task_short: null,
    owner_id: null,
    status: "in_progress",
    verdict: null,
    started_at: NOW,
    ended_at: null,
    gate_policies: {} as Record<GateRole, PolicyName>,
    decisions: {},
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
      flow_name: "planning",
      step_index: 2,
      complete: false,
      pending_user_answer: null,
      scratch: {},
    },
    phases: [
      { name: "planning", status: "pending", skipped_reason: null, phase_extension: null, updated_at: NOW },
    ],
    gates: {},
    agent_verdicts: [],
    pending_agents: [],
    now: NOW,
  };
}
