// Full-cycle integration of the deterministic checks over a REAL SQLite store —
// the real apply-checks Step body recording a real finding through the real
// drain path, the real findings access surface counting it, the real gate
// policy resolver walking back on it, and the real substrate invariant vetoing
// a trivial-flow finalize while it is live. No mocked database; only the
// child-process / model seams are absent (the envelope is seeded as the
// checks-runner spawn's structured output would land it).
//
// The cycle proven here:
//   failed check → blocking finding → final gate auto-rejects (walk-back),
//   and the reviewer self-gate keeps the review fanout from running that round;
//   a green re-run records no finding → reviewers run → the final gate approves;
//   and in the gate-less trivial flow a live blocking check finding vetoes the
//   accepted verdict (the run parks rather than silently finishing).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  KernelError,
  applyBundleOps,
  buildStageContext,
  buildVocabularies,
  closeDb,
  materializeAccessSnapshot,
  openDb,
  withStateTransaction,
} from "@loomfsm/kernel";
import type {
  Bundle,
  BundleStateView,
  GateRole,
  LLMProvider,
  NowToken,
  PipelineState,
  Policy,
  PolicyContext,
  PolicyName,
  Registry,
} from "@loomfsm/kernel";

import codeBundle from "../src/bundle.js";
import { codePolicyResolver } from "../src/policy-resolver.js";

const NOW = "2026-06-12T10:00:00.000Z" as NowToken;
const DRIVER = "d-checks-int";
const TASK = "t-2026-06-12-checks";

// One check-result envelope row as the executor emits it (and the bundle's
// structured-output merge lands under `decisions.checks`).
interface CheckRow {
  name: string;
  status: string;
  exit_code?: number | null;
  output_head?: string;
  output_tail?: string;
  command?: string;
}

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "loom-checks-int-"));
}
function cleanup(dir: string): void {
  try {
    closeDb(dir);
  } catch {
    /* may already be closed */
  }
  rmSync(dir, { recursive: true, force: true });
}

// Seed a pipeline parked at the apply-checks point, with the implementation
// phase swept terminal so ONLY a live blocker can object to an accepted verdict
// (mirrors the substrate's gate-less trivial flow at finalize).
async function seed(dir: string): Promise<void> {
  await withStateTransaction(dir, NOW, async (tx) => {
    await tx.exec(
      "INSERT INTO pipeline_state (id, schema_version, project_dir, bundle, task_id, " +
        "task, driver_state_id, status, verdict, started_at, gate_policies, decisions) " +
        "VALUES (1, '3.0.0', ?, 'code', ?, 'seeded task', ?, 'in_progress', NULL, ?, '{}', '{}')",
      [dir, TASK, DRIVER, NOW],
    );
    await tx.exec(
      "INSERT INTO driver_state (id, flow_name, step_index, complete, pending_user_answer, scratch) " +
        "VALUES (1, 'implementation', 5, 0, NULL, '{}')",
    );
    await tx.exec("INSERT INTO pipeline_counters (id) VALUES (1)");
    await tx.exec(
      "INSERT INTO phases (name, status, skipped_reason, updated_at) " +
        "VALUES ('implementation', 'skipped', 'swept for fixture', ?)",
      [NOW],
    );
  });
}

// A minimal in-memory PipelineState whose `decisions.checks` carries the
// executor envelope (the only field apply-checks reads besides task_id).
function stateWithChecks(dir: string, checks: CheckRow[]): PipelineState {
  return {
    schema_version: "3.0.0",
    task_id: TASK,
    driver_state_id: DRIVER,
    project_dir: dir,
    bundle: "code",
    task: "seeded task",
    task_short: null,
    owner_id: null,
    status: "in_progress",
    verdict: null,
    started_at: NOW,
    ended_at: null,
    gate_policies: {} as Record<GateRole, PolicyName>,
    decisions: { checks },
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
    driver: { flow_name: "implementation", step_index: 5, complete: false, pending_user_answer: null, scratch: {} },
    phases: [
      { name: "implementation", status: "skipped", skipped_reason: "swept for fixture", phase_extension: null, updated_at: NOW },
    ],
    gates: {},
    agent_verdicts: [],
    pending_agents: [],
    now: NOW,
  };
}

function stubRegistry(): Registry {
  const stubProvider: LLMProvider = {
    name: "stub",
    capabilities: { execution: "shuttle", idempotent_spawn: true, reports_usage: true },
    async spawn() {
      throw new Error("stub provider — spawn must not run");
    },
  };
  const bundle: Bundle = {
    name: "code",
    version: "0.0.1",
    description: "checks integration fixture",
    phases: ["implementation"],
    default_flow: "impl",
    default_gate_policies: {} as Record<GateRole, PolicyName>,
    gate_roles: {},
    agents: [],
    stages: {},
    flows: { impl: ["x"] },
    hooks: [],
    invariants: [],
  };
  return {
    bundle,
    agents: new Map(),
    stages: new Map(),
    flows: new Map([["impl", ["x"]]]),
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

// Run the registered apply-checks Step body over a real ctx (real findings
// access + the real BundleScratchTx mutator) and commit its ops under the
// implementation phase, the same drain the tick uses.
async function applyChecks(dir: string, checks: CheckRow[]): Promise<void> {
  await withStateTransaction(dir, NOW, async (tx) => {
    const { ctx, ops } = await buildStageContext(stateWithChecks(dir, checks), stubRegistry(), tx);
    const stage = codeBundle.stages["apply-checks"];
    assert.ok(stage !== undefined && stage.kind === "step" && stage.run !== undefined);
    await stage.run(ctx.state, ctx);
    await applyBundleOps(tx, ops, "implementation", 1);
  });
}

async function openBlockingCount(dir: string): Promise<number> {
  return withStateTransaction(dir, NOW, async (tx) => {
    const snap = await materializeAccessSnapshot(tx);
    return snap.findings.countBlocking({ phase: "implementation" });
  });
}

async function readDecisions(dir: string): Promise<Record<string, unknown>> {
  return withStateTransaction(dir, NOW, async (tx) => {
    const row = await tx.queryRow<{ decisions: string }>("SELECT decisions FROM pipeline_state WHERE id = 1");
    return JSON.parse(row?.decisions ?? "{}") as Record<string, unknown>;
  });
}

// A reviewer's `applies_to` over a decisions snapshot — true ⇒ it would run.
function reviewerWouldRun(name: string, decisions: Record<string, unknown>): boolean {
  const agent = codeBundle.agents.find((a) => a.name === name);
  assert.ok(agent?.applies_to !== undefined, `agent '${name}' must declare applies_to`);
  const state = { decisions, agent_verdicts: [], files_modified: [] } as unknown as BundleStateView;
  return agent.applies_to(state);
}

// The final-gate policy decision over the real materialized finding surface.
async function finalGateDecision(dir: string): Promise<ReturnType<typeof codePolicyResolver>> {
  return withStateTransaction(dir, NOW, async (tx) => {
    const snap = await materializeAccessSnapshot(tx);
    const ctx = {
      bundle: codeBundle,
      findings: snap.findings,
      agents_query: snap.agents_query,
      latest_verdict: () => null,
      rolePhase: () => null,
      now: NOW,
    } as unknown as PolicyContext;
    const state = { agent_verdicts: [] } as unknown as BundleStateView;
    return codePolicyResolver(state, "final" as GateRole, ctx);
  });
}

describe("@loomfsm/bundle-code — deterministic checks, full cycle on real SQLite", () => {
  let dir: string;
  beforeEach(() => {
    dir = freshProject();
    openDb(dir);
  });
  afterEach(() => cleanup(dir));

  it("a failed check records a live blocking finding, gates the review fanout off, and walks the final gate back", async () => {
    await seed(dir);
    await applyChecks(dir, [
      {
        name: "typecheck",
        status: "fail",
        exit_code: 2,
        output_head: "src/foo.ts(12,5): error TS2345: not assignable",
        output_tail: "Found 1 error.",
        command: "pnpm run typecheck",
      },
      { name: "lint", status: "ok", exit_code: 0 },
      { name: "test", status: "skipped" },
    ]);

    // The real findings surface now carries exactly one live blocking finding,
    // built from the head and pointing at the full-output file.
    assert.equal(await openBlockingCount(dir), 1);
    const finding = await withStateTransaction(dir, NOW, (tx) =>
      tx.queryRow<{ category: string; severity: string; status: string; evidence_excerpt: string | null; suggested_fix: string | null }>(
        "SELECT category, severity, status, evidence_excerpt, suggested_fix FROM findings WHERE task_id = ? ORDER BY id ASC LIMIT 1",
        [TASK],
      ),
    );
    assert.equal(finding?.category, "failed-check");
    assert.equal(finding?.severity, "blocking");
    assert.equal(finding?.status, "open");
    assert.ok((finding?.evidence_excerpt ?? "").includes("error TS2345"), "evidence carries the head");
    assert.ok((finding?.suggested_fix ?? "").includes(".loom/work/check-failures.txt"), "fix points at the file");

    // The reviewer self-gate is off for this round → the review fanout does NOT
    // run. `source_changed` is present so the ONLY reason they sit out is the
    // failed checks, not an absent diff.
    const decisions = await readDecisions(dir);
    assert.equal(decisions["checks_ok"], false);
    const reviewGate = { ...decisions, source_changed: true };
    assert.equal(reviewerWouldRun("logic-reviewer", reviewGate), false);
    assert.equal(reviewerWouldRun("challenger-reviewer", reviewGate), false);

    // The final gate auto-rejects (walk-back), counted against the replan cap.
    const decision = await finalGateDecision(dir);
    assert.equal(decision.type, "auto-reject");
    assert.equal(decision.type === "auto-reject" ? decision.reject_intent : undefined, "revise");
    assert.equal(decision.type === "auto-reject" ? decision.counts_against_replan_cap : undefined, true);
  });

  it("a green re-run records no finding, lets the reviewers run, and the final gate approves", async () => {
    await seed(dir);
    await applyChecks(dir, [
      { name: "typecheck", status: "ok", exit_code: 0 },
      { name: "lint", status: "ok", exit_code: 0 },
      { name: "test", status: "ok", exit_code: 0 },
    ]);

    assert.equal(await openBlockingCount(dir), 0);
    const decisions = await readDecisions(dir);
    assert.equal(decisions["checks_ok"], true);
    // With checks green the review fanout runs on changed source.
    assert.equal(reviewerWouldRun("logic-reviewer", { ...decisions, source_changed: true }), true);

    const decision = await finalGateDecision(dir);
    assert.equal(decision.type, "auto-approve");
  });

  it("in the gate-less trivial flow a live blocking check finding vetoes the accepted verdict", async () => {
    await seed(dir);
    await applyChecks(dir, [
      { name: "test", status: "fail", exit_code: 1, output_head: "1 failing test", command: "node --test" },
    ]);
    assert.equal(await openBlockingCount(dir), 1);

    // Trivial has no gate to walk back through; the substrate's accepted-⊥-live-
    // blocker invariant refuses to let the finalize commit an accepted verdict.
    await assert.rejects(
      withStateTransaction(dir, NOW, (tx) =>
        tx.exec("UPDATE pipeline_state SET verdict = 'accepted' WHERE id = 1"),
      ),
      (err: unknown) =>
        err instanceof KernelError &&
        err.code === "INVARIANT_VIOLATION" &&
        JSON.stringify(err.detail).includes("INV_008"),
    );
  });
});
