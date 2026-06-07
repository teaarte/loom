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
  loadState,
  materializeAccessSnapshot,
  openDb,
  withStateTransaction,
} from "@loomfsm/kernel";
import type {
  Bundle,
  BundleStateView,
  ConditionalSpawnContext,
  Finding,
  FindingsAccess,
  GateRole,
  LLMProvider,
  NowToken,
  PipelineState,
  Policy,
  PolicyName,
  Registry,
  SpawnStage,
  StageContext,
  StepStage,
} from "@loomfsm/kernel";

import codeBundle from "../src/bundle.js";

const NOW = "2026-06-02T12:00:00.000Z" as NowToken;
const DRIVER = "d-adjudicate";
const TASK = "t-2026-06-02-adj";

// ============================================================================
// P1 — the `when` predicate (pure). Reads only the generic outcome subset and
// the bundle's domain conventions; no DB needed.
// ============================================================================

function adjudicateWhen(): SpawnStage["when"] {
  const stage = codeBundle.stages["adjudicate"];
  assert.ok(stage !== undefined && stage.kind === "spawn", "adjudicate is a spawn stage");
  assert.ok(stage.when !== undefined, "adjudicate carries a `when` predicate");
  return stage.when;
}

function mkFinding(p: Partial<Finding>): Finding {
  return {
    schema_version: "1.0",
    id: p.id ?? "f-x",
    agent: p.agent ?? "logic-reviewer",
    iteration: p.iteration ?? 1,
    task_id: p.task_id ?? TASK,
    file: p.file ?? "src/x.ts",
    line_start: p.line_start ?? 10,
    line_end: p.line_end ?? 12,
    severity: p.severity ?? "blocking",
    category: p.category ?? "race-condition",
    proposed_new_category: p.proposed_new_category ?? null,
    pattern_id: p.pattern_id ?? null,
    summary: p.summary ?? "claims a runtime race",
    evidence_excerpt: p.evidence_excerpt ?? null,
    suggested_fix: p.suggested_fix ?? null,
    status: p.status ?? "open",
    ref_rule_id: p.ref_rule_id ?? null,
  };
}

// A minimal in-memory FindingsAccess over a phase-tagged finding list (mirrors
// the kernel's materialized access; the predicate tests only seed LIVE rows).
function accessOf(rows: { phase: string; finding: Finding }[]): FindingsAccess {
  return {
    query(f) {
      return rows
        .filter((r) => {
          if (f.phase !== undefined && r.phase !== f.phase) return false;
          if (f.agent !== undefined && r.finding.agent !== f.agent) return false;
          if (f.severity !== undefined && !f.severity.includes(r.finding.severity)) return false;
          if (f.status !== undefined && !f.status.includes(r.finding.status)) return false;
          return true;
        })
        .map((r) => r.finding);
    },
    countBlocking(f) {
      return rows.filter(
        (r) =>
          (f?.phase === undefined || r.phase === f.phase) &&
          r.finding.severity === "blocking" &&
          r.finding.status === "open",
      ).length;
    },
    queryByPhase(phase) {
      return rows.filter((r) => r.phase === phase).map((r) => r.finding);
    },
  };
}

function ctxOf(rows: { phase: string; finding: Finding }[]): ConditionalSpawnContext {
  return { findings: accessOf(rows), agents_query: { query: () => [] }, now: NOW };
}

function viewWith(p: Partial<BundleStateView>): BundleStateView {
  return {
    agent_verdicts: [],
    files_modified: [],
    files_created: [],
    decisions: {},
    ...p,
  } as unknown as BundleStateView;
}

const RUNTIME_BLOCKER = { phase: "implementation", finding: mkFinding({ id: "f-rt", category: "race-condition" }) };

describe("adjudicate.when — escalation predicate", () => {
  it("fires on a live blocking runtime claim when the reviewers disagree", () => {
    const fire = adjudicateWhen()!;
    const state = viewWith({
      agent_verdicts: [
        { phase: "implementation", agent: "logic-reviewer", iteration: 1, verdict: "REQUEST_CHANGES", summary_line: null, blocking_issues: 1, warn_issues: 0, info_issues: 0, categories_seen: [], recorded_at: NOW },
        { phase: "implementation", agent: "challenger-reviewer", iteration: 1, verdict: "APPROVE", summary_line: null, blocking_issues: 0, warn_issues: 0, info_issues: 0, categories_seen: [], recorded_at: NOW },
      ],
    });
    assert.equal(fire(state, ctxOf([RUNTIME_BLOCKER])), true);
  });

  it("fires on a live blocking runtime claim that touches a hot path (no disagreement needed)", () => {
    const fire = adjudicateWhen()!;
    const state = viewWith({ files_modified: ["src/server.ts"] });
    assert.equal(fire(state, ctxOf([RUNTIME_BLOCKER])), true);
  });

  it("does NOT fire when the blocking finding is not a runtime claim", () => {
    const fire = adjudicateWhen()!;
    const state = viewWith({ files_modified: ["src/server.ts"] });
    const styleBlocker = { phase: "implementation", finding: mkFinding({ id: "f-st", category: "naming-violation" }) };
    assert.equal(fire(state, ctxOf([styleBlocker])), false);
  });

  it("does NOT fire when there is a runtime claim but no escalator (agreement + cold path)", () => {
    const fire = adjudicateWhen()!;
    const state = viewWith({
      files_modified: ["src/util/format.ts"],
      agent_verdicts: [
        { phase: "implementation", agent: "logic-reviewer", iteration: 1, verdict: "REQUEST_CHANGES", summary_line: null, blocking_issues: 1, warn_issues: 0, info_issues: 0, categories_seen: [], recorded_at: NOW },
      ],
    });
    assert.equal(fire(state, ctxOf([RUNTIME_BLOCKER])), false);
  });

  it("does NOT fire when no blocker is live", () => {
    const fire = adjudicateWhen()!;
    const state = viewWith({ files_modified: ["src/server.ts"] });
    const resolved = { phase: "implementation", finding: mkFinding({ id: "f-done", status: "dismissed" }) };
    assert.equal(fire(state, ctxOf([resolved])), false);
  });
});

// ============================================================================
// P1b — the acceptance spawn (`final-checks`) self-skips while an impl-phase
// reviewer blocker is still live, so an acceptance PASS can never be recorded
// over an open blocker (which would trip INV_CODE_104 and crash the run).
// ============================================================================

function acceptanceWhen(): SpawnStage["when"] {
  const stage = codeBundle.stages["final-checks"];
  assert.ok(stage !== undefined && stage.kind === "spawn", "final-checks is a spawn stage");
  assert.ok(stage.when !== undefined, "final-checks carries a `when` predicate");
  return stage.when;
}

describe("final-checks.when — acceptance gates on a clean review", () => {
  it("does NOT run acceptance while an impl-phase reviewer blocker is live", () => {
    const run = acceptanceWhen()!;
    // A surviving non-runtime blocker (a style violation the adjudicator never
    // touches) — exactly the case that crashed the complex flow.
    const styleBlocker = { phase: "implementation", finding: mkFinding({ id: "f-style", agent: "style-reviewer", category: "naming-violation" }) };
    assert.equal(run(viewWith({}), ctxOf([styleBlocker])), false);
  });

  it("runs acceptance once the review is free of live blockers", () => {
    const run = acceptanceWhen()!;
    assert.equal(run(viewWith({}), ctxOf([])), true);
    // A dismissed blocker is not live → acceptance proceeds.
    const dismissed = { phase: "implementation", finding: mkFinding({ id: "f-gone", status: "dismissed" }) };
    assert.equal(run(viewWith({}), ctxOf([dismissed])), true);
  });
});

// ============================================================================
// P2 — reconcile applies the adjudicator's verdict to the ORIGINAL finding,
// against a real SQLite DB, and the override changes live-blocking + inv008.
// ============================================================================

function reconcileRun(): NonNullable<StepStage["run"]> {
  const stage = codeBundle.stages["reconcile"];
  assert.ok(stage !== undefined && stage.kind === "step" && stage.run !== undefined);
  return stage.run;
}

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "loom-adj-"));
}
function cleanup(dir: string): void {
  try {
    closeDb(dir);
  } catch {
    /* may already be closed */
  }
  rmSync(dir, { recursive: true, force: true });
}

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
        "VALUES (1, 'implementation', 13, 0, NULL, '{}')",
    );
    await tx.exec("INSERT INTO pipeline_counters (id) VALUES (1)");
    // Implementation phase swept terminal so ONLY the acceptance veto can
    // object to an accepted verdict.
    await tx.exec(
      "INSERT INTO phases (name, status, skipped_reason, updated_at) " +
        "VALUES ('implementation', 'skipped', 'swept for fixture', ?)",
      [NOW],
    );
  });
}

async function insertFinding(
  dir: string,
  f: { id: string; agent: string; category: string; severity: string; file: string; line_start: number },
): Promise<void> {
  await withStateTransaction(dir, NOW, async (tx) => {
    await tx.exec(
      "INSERT INTO findings (id, task_id, agent, iteration, phase, file, line_start, " +
        "line_end, severity, category, proposed_new_category, pattern_id, summary, " +
        "evidence_excerpt, suggested_fix, status, ref_rule_id, recorded_at) " +
        "VALUES (?, ?, ?, 1, 'implementation', ?, ?, ?, ?, ?, NULL, NULL, 'fixture', " +
        "NULL, NULL, 'open', NULL, ?)",
      [f.id, TASK, f.agent, f.file, f.line_start, f.line_start, f.severity, f.category, NOW],
    );
  });
}

async function countBlocking(dir: string): Promise<number> {
  return withStateTransaction(dir, NOW, async (tx) => {
    const snap = await materializeAccessSnapshot(tx);
    return snap.findings.countBlocking({ phase: "implementation" });
  });
}

// Drive the reconcile run body against a real ctx (materialized findings + the
// real BundleScratchTx mutator binding) and commit its ops.
async function runReconcile(dir: string): Promise<void> {
  await withStateTransaction(dir, NOW, async (tx) => {
    const { ctx, ops } = await buildStageContext(inMemoryState(dir), stubRegistry(), tx);
    await reconcileRun()(ctx.state, ctx);
    await applyBundleOps(tx, ops);
  });
}

describe("adjudicate — reconcile applies the verdict to the original (real SQLite)", () => {
  let dir: string;
  beforeEach(() => {
    dir = freshProject();
    openDb(dir);
  });
  afterEach(() => cleanup(dir));

  it("a refuted verdict downgrades the original blocker → live-blocking clears, accept passes", async () => {
    await seed(dir);
    await insertFinding(dir, { id: "f-orig", agent: "logic-reviewer", category: "race-condition", severity: "blocking", file: "src/x.ts", line_start: 10 });
    await insertFinding(dir, { id: "f-mark", agent: "adjudicator", category: "runtime-refuted", severity: "info", file: "src/x.ts", line_start: 10 });
    assert.equal(await countBlocking(dir), 1);

    await runReconcile(dir);

    // The original is no longer a live blocker (downgraded to info). Revert the
    // applier arm or the reconcile body and this stays 1 → reddens.
    assert.equal(await countBlocking(dir), 0);
    const row = await withStateTransaction(dir, NOW, (tx) =>
      tx.queryRow<{ severity: string; status: string }>(
        "SELECT severity, status FROM findings WHERE id = 'f-orig'",
      ),
    );
    assert.equal(row?.severity, "info");

    // inv008: the final accept now commits (no live blocker stands).
    await withStateTransaction(dir, NOW, (tx) =>
      tx.exec("UPDATE pipeline_state SET verdict = 'accepted' WHERE id = 1"),
    );
    assert.equal((await withStateTransaction(dir, NOW, (tx) => loadState(tx))).verdict, "accepted");
  });

  it("a confirmed verdict keeps the original blocking → accept stays vetoed by inv008", async () => {
    await seed(dir);
    await insertFinding(dir, { id: "f-orig", agent: "logic-reviewer", category: "race-condition", severity: "blocking", file: "src/x.ts", line_start: 10 });
    await insertFinding(dir, { id: "f-mark", agent: "adjudicator", category: "runtime-confirmed", severity: "info", file: "src/x.ts", line_start: 10 });

    await runReconcile(dir);

    assert.equal(await countBlocking(dir), 1);
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

  it("no adjudicator marker → reconcile is a no-op, the blocker is untouched", async () => {
    await seed(dir);
    await insertFinding(dir, { id: "f-orig", agent: "logic-reviewer", category: "race-condition", severity: "blocking", file: "src/x.ts", line_start: 10 });

    await runReconcile(dir);

    assert.equal(await countBlocking(dir), 1, "no marker ⇒ nothing overridden");
  });

  it("a marker whose location does not match any blocker leaves the blocker live", async () => {
    await seed(dir);
    await insertFinding(dir, { id: "f-orig", agent: "logic-reviewer", category: "race-condition", severity: "blocking", file: "src/x.ts", line_start: 10 });
    await insertFinding(dir, { id: "f-mark", agent: "adjudicator", category: "runtime-refuted", severity: "info", file: "src/other.ts", line_start: 99 });

    await runReconcile(dir);

    assert.equal(await countBlocking(dir), 1, "unmatched marker ⇒ no override");
  });
});

// ============================================================================
// Fixtures for buildStageContext (reconcile only touches ctx.findings + ctx.tx)
// ============================================================================

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
    description: "adjudicate fixture",
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

function inMemoryState(dir: string): PipelineState {
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
      flow_name: "implementation",
      step_index: 13,
      complete: false,
      pending_user_answer: null,
      scratch: {},
    },
    phases: [
      { name: "implementation", status: "skipped", skipped_reason: "swept for fixture", phase_extension: null, updated_at: NOW },
    ],
    gates: {},
    agent_verdicts: [],
    pending_agents: [],
    now: NOW,
  };
}
