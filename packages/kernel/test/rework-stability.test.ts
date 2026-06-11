// Rework-loop stability — two kernel mechanisms that make a gate rejection
// converge and never silently pass:
//
//   1. Open-blocker hand-off: a gate walk-back snapshots the rejecting round's
//      live blockers into the driver scratch BEFORE superseding them, so the
//      re-entered flow's first spawn can list them and the fixer knows what to
//      address (the prompt renderer reads the same scratch). A gate approval
//      clears the snapshot.
//   2. Unparseable-output policy: a reviewer/validator whose output cannot be
//      parsed is retried once (where the spawn can be re-issued) and otherwise
//      turned into a blocking finding through the normal path — so a gate sees
//      it like any other blocker rather than reading "no blockers" and
//      approving.
//
// Real SQLite throughout (in a temp project), no mocks.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { buildPrompt } from "../src/index.js";
import { deliverContinue } from "../src/lib/deliver-continue.js";
import { materializeAccessSnapshot } from "../src/lib/access-snapshots.js";
import {
  clearOpenBlockers,
  snapshotOpenBlockers,
  supersedeFindingsOnWalkBack,
} from "../src/lib/supersede-findings.js";
import { _resetInvariantsForTest } from "../src/invariants.js";
import {
  captureNow,
  closeDb,
  openDb,
  withStateTransaction,
} from "../src/state.js";
import type { NowToken } from "../src/types/now.js";
import type { Stage } from "../src/types/plugins.js";
import type { RenderedTemplate } from "../src/types/extension.js";
import type { Registry } from "../src/types/registry.js";
import type { PipelineState } from "../src/types/state.js";

const NOW = "2026-06-11T10:00:00.000Z" as NowToken;
const DRIVER = "d-rework";

const IMPL_FLOW = ["implement", "review", "gate-final"];
function implStages(): Map<string, Stage> {
  return new Map<string, Stage>([
    ["implement", { kind: "spawn", name: "implement", phase: "implementation", agent: "implementer" }],
    ["review", { kind: "fanout", name: "review", phase: "implementation", agents: [] }],
    [
      "gate-final",
      {
        kind: "gate",
        name: "gate-final",
        phase: "validation",
        message: () => "approve?",
        valid_answers: () => ({ options: [] }),
      },
    ],
  ]);
}

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "loom-rework-"));
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
  step_index?: number;
  scratch?: string;
  pending?: { agent_run_id: string; agent: string; phase: string };
}

async function seed(dir: string, opts: SeedOpts = {}): Promise<void> {
  const scratch = opts.scratch ?? "{}";
  const stepIndex = opts.step_index ?? 1;
  await withStateTransaction(dir, NOW, async (tx) => {
    await tx.exec(
      "INSERT INTO pipeline_state (id, schema_version, project_dir, bundle, task_id, " +
        "task, driver_state_id, status, verdict, started_at, gate_policies, decisions) " +
        "VALUES (1, '3.0.0', ?, 'code-fixture', 't-2026-06-11-rw', 'seeded task', ?, " +
        "'in_progress', NULL, ?, '{}', '{}')",
      [dir, DRIVER, NOW],
    );
    await tx.exec(
      "INSERT INTO driver_state (id, flow_name, step_index, complete, pending_user_answer, scratch) " +
        "VALUES (1, 'impl', ?, 0, NULL, ?)",
      [stepIndex, scratch],
    );
    await tx.exec("INSERT INTO pipeline_counters (id) VALUES (1)");
    await tx.exec(
      "INSERT INTO phases (name, status, skipped_reason, updated_at) VALUES ('implementation', 'in_progress', NULL, ?)",
      [NOW],
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
  opts: { id: string; agent: string; category?: string; file?: string | null; suggested_fix?: string | null },
): Promise<void> {
  await withStateTransaction(dir, NOW, async (tx) => {
    await tx.exec(
      "INSERT INTO findings (id, task_id, agent, iteration, phase, file, line_start, " +
        "line_end, severity, category, proposed_new_category, pattern_id, summary, " +
        "evidence_excerpt, suggested_fix, status, ref_rule_id, recorded_at) " +
        "VALUES (?, 't-2026-06-11-rw', ?, 1, 'implementation', ?, 42, NULL, " +
        "'blocking', ?, NULL, NULL, 'the bug', NULL, ?, 'open', NULL, ?)",
      [opts.id, opts.agent, opts.file ?? "src/x.ts", opts.category ?? "correctness", opts.suggested_fix ?? "fix it", NOW],
    );
  });
}

async function readScratch(dir: string): Promise<Record<string, unknown>> {
  return withStateTransaction(dir, NOW, async (tx) => {
    const row = await tx.queryRow<{ scratch: string | null }>(
      "SELECT scratch FROM driver_state WHERE id = 1",
    );
    return JSON.parse(row?.scratch ?? "{}") as Record<string, unknown>;
  });
}

async function readStepIndex(dir: string): Promise<number> {
  return withStateTransaction(dir, NOW, async (tx) => {
    const row = await tx.queryRow<{ step_index: number }>(
      "SELECT step_index FROM driver_state WHERE id = 1",
    );
    return Number(row?.step_index);
  });
}

async function countBlocking(dir: string): Promise<number> {
  return withStateTransaction(dir, NOW, async (tx) => {
    const snap = await materializeAccessSnapshot(tx);
    return snap.findings.countBlocking({});
  });
}

// ============================================================================
// A1 — open-blocker hand-off: snapshot BEFORE supersede, then render it
// ============================================================================

describe("rework stability — open-blocker hand-off", () => {
  let dir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    dir = freshProject();
    openDb(dir);
  });
  afterEach(() => cleanup(dir));

  it("snapshots the live blockers, then supersede retires them — the snapshot survives", async () => {
    await seed(dir);
    await insertBlocking(dir, {
      id: "f-1",
      agent: "logic-reviewer",
      category: "correctness",
      file: "src/orders.ts",
      suggested_fix: "catch P2002",
    });
    assert.equal(await countBlocking(dir), 1);

    // The gate's order: snapshot the live blockers, THEN supersede. The
    // supersede write must carry the snapshot forward (same scratch blob).
    await withStateTransaction(dir, NOW, async (tx) => {
      let scratch = await snapshotOpenBlockers(tx, {});
      scratch = await supersedeFindingsOnWalkBack(tx, {
        flow: IMPL_FLOW,
        stages: implStages(),
        targetIndex: 0,
        currentIndex: 2,
        scratch,
      });
    });

    // The finding is retired (no longer live) AND the snapshot is preserved.
    assert.equal(await countBlocking(dir), 0);
    const scratch = await readScratch(dir);
    const blockers = scratch["open_blockers"] as Array<Record<string, unknown>>;
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0]?.["file"], "src/orders.ts");
    assert.equal(blockers[0]?.["line"], 42);
    assert.equal(blockers[0]?.["category"], "correctness");
    assert.equal(blockers[0]?.["suggested_fix"], "catch P2002");
    assert.equal(blockers[0]?.["agent"], "logic-reviewer");
  });

  it("the next spawn renders the snapshot under '### Open blockers'", async () => {
    await seed(dir);
    await insertBlocking(dir, { id: "f-1", agent: "logic-reviewer" });
    await withStateTransaction(dir, NOW, (tx) => snapshotOpenBlockers(tx, {}));

    const scratch = await readScratch(dir);
    const state = {
      task: "fix the bug",
      task_id: "t-2026-06-11-rw",
      driver_state_id: DRIVER,
      project_dir: dir,
      task_short: null,
      decisions: {},
      driver: { flow_name: "impl", scratch },
    } as unknown as PipelineState;
    const prompts = new Map<string, RenderedTemplate>([
      ["implementer", { agent: "implementer", body: "# Implementer\n" }],
    ]);
    const out = buildPrompt(
      state,
      { name: "implementer", template_path: "agents/implementer.md", output_kind: "nonreview" },
      { prompts } as unknown as Registry,
    );
    assert.ok(out.includes("### Open blockers"));
    assert.ok(out.includes("the bug"));
  });

  it("clearOpenBlockers drops the snapshot (a gate approval)", async () => {
    await seed(dir);
    await insertBlocking(dir, { id: "f-1", agent: "logic-reviewer" });
    await withStateTransaction(dir, NOW, (tx) => snapshotOpenBlockers(tx, {}));
    assert.ok("open_blockers" in (await readScratch(dir)));

    await withStateTransaction(dir, NOW, async (tx) => {
      const scratch = await snapshotOpenBlockers(tx, {}); // current scratch incl. the key
      await clearOpenBlockers(tx, scratch);
    });
    assert.ok(!("open_blockers" in (await readScratch(dir))));
  });
});

// ============================================================================
// A2 — unparseable reviewer/validator never silently passes a gate
// ============================================================================

const UNPARSEABLE = "this is not JSON and has no fenced header";

describe("rework stability — unparseable reviewer output", () => {
  let dir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    dir = freshProject();
    openDb(dir);
  });
  afterEach(() => cleanup(dir));

  it("a lone reviewer spawn is retried once (no finding, step held), then blocked", async () => {
    // step_index 1 = the 'review' spawn position in this fixture.
    await seed(dir, { step_index: 1, pending: { agent_run_id: "ar-1", agent: "logic-reviewer", phase: "implementation" } });

    // First failure → retried: no finding, and the step is HELD (not advanced)
    // so the FSM re-issues the spawn.
    await withStateTransaction(dir, NOW, (tx) =>
      deliverContinue(tx, {
        input: { type: "agent-result", agent_run_id: "ar-1", agent_output: UNPARSEABLE },
        driver_state_id: DRIVER,
        resolveOutputKind: () => "reviewer",
      }),
    );
    assert.equal(await countBlocking(dir), 0, "first failure is retried, not blocked");
    assert.equal(await readStepIndex(dir), 1, "step held for the re-issue");

    // The re-issued spawn (fresh agent_run_id) fails again → blocked, step advances.
    await seed2ndPending(dir, "ar-2", "logic-reviewer");
    await withStateTransaction(dir, NOW, (tx) =>
      deliverContinue(tx, {
        input: { type: "agent-result", agent_run_id: "ar-2", agent_output: UNPARSEABLE },
        driver_state_id: DRIVER,
        resolveOutputKind: () => "reviewer",
      }),
    );
    assert.equal(await countBlocking(dir), 1, "second failure synthesizes a blocking finding");
    assert.equal(await readStepIndex(dir), 2, "step advances once blocked");
  });

  it("a fanout sibling is blocked on the FIRST failure (no unsafe re-run)", async () => {
    await seed(dir, { step_index: 1, pending: { agent_run_id: "ar-f1", agent: "logic-reviewer", phase: "implementation" } });

    await withStateTransaction(dir, NOW, (tx) =>
      deliverContinue(tx, {
        input: { type: "agents-results", results: [{ agent_run_id: "ar-f1", agent_output: UNPARSEABLE }] },
        driver_state_id: DRIVER,
        resolveOutputKind: () => "reviewer",
      }),
    );
    // Blocked immediately — a fanout sibling cannot be re-issued alone.
    assert.equal(await countBlocking(dir), 1);
    assert.equal(await readStepIndex(dir), 2, "fanout advances when drained");
  });

  it("a clean reviewer delivery records its findings normally (control)", async () => {
    await seed(dir, { step_index: 1, pending: { agent_run_id: "ar-ok", agent: "logic-reviewer", phase: "implementation" } });
    const clean = "```json\n" + JSON.stringify({
      verdict: "REQUEST_CHANGES",
      findings: [{ severity: "blocking", category: "correctness", summary: "real issue" }],
    }) + "\n```";
    await withStateTransaction(dir, NOW, (tx) =>
      deliverContinue(tx, {
        input: { type: "agent-result", agent_run_id: "ar-ok", agent_output: clean },
        driver_state_id: DRIVER,
        resolveOutputKind: () => "reviewer",
      }),
    );
    assert.equal(await countBlocking(dir), 1);
    assert.equal(await readStepIndex(dir), 2);
  });
});

async function seed2ndPending(dir: string, arid: string, agent: string): Promise<void> {
  await withStateTransaction(dir, NOW, async (tx) => {
    await tx.exec(
      "INSERT INTO pending_agents (agent_run_id, agent, phase, model, started_at) " +
        "VALUES (?, ?, 'implementation', NULL, ?)",
      [arid, agent, NOW],
    );
  });
}
