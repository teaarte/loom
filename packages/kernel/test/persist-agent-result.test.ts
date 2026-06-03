import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { buildAgentResult } from "../src/lib/build-agent-result.js";
import { persistAgentResult } from "../src/lib/persist-agent-result.js";
import { kernelDefaultVocabularies } from "../src/vocabularies.js";
import { _resetInvariantsForTest } from "../src/invariants.js";
import {
  KernelError,
  captureNow,
  closeDb,
  loadState,
  openDb,
  withStateTransaction,
} from "../src/state.js";
import type { NowToken } from "../src/types/now.js";

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "loom-persist-"));
}

function cleanup(projectDir: string): void {
  try {
    closeDb(projectDir);
  } catch {
    /* may have already closed */
  }
  rmSync(projectDir, { recursive: true, force: true });
}

async function seedBaseline(projectDir: string): Promise<NowToken> {
  const now = captureNow();
  await withStateTransaction(projectDir, now, async (tx) => {
    await tx.exec(
      "INSERT INTO pipeline_state (id, schema_version, project_dir, bundle, " +
        "task, task_id, driver_state_id, status, started_at, decisions) " +
        "VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "3.0.0",
        projectDir,
        "stub-bundle",
        "persist fixture",
        "t-2026-05-28-persist",
        "d-persist",
        "in_progress",
        now,
        "{}",
      ],
    );
    await tx.exec(
      "INSERT INTO driver_state (id, flow_name, step_index, complete) " +
        "VALUES (1, 'default', 0, 0)",
    );
    await tx.exec("INSERT INTO pipeline_counters (id) VALUES (1)");
    await tx.exec(
      "INSERT INTO phases (name, status, updated_at) VALUES ('p1', 'in_progress', ?)",
      [now],
    );
  });
  return now;
}

async function seedPending(projectDir: string, agent_run_id: string, agent: string): Promise<void> {
  const now = captureNow();
  await withStateTransaction(projectDir, now, async (tx) => {
    await tx.exec(
      "INSERT INTO pending_agents (agent_run_id, agent, phase, model, started_at) " +
        "VALUES (?, ?, 'p1', NULL, ?)",
      [agent_run_id, agent, now],
    );
  });
}

// ============================================================================
// buildAgentResult
// ============================================================================

describe("buildAgentResult", () => {
  it("returns schema_validation ok for nonreview kind", () => {
    const r = buildAgentResult({
      agent: "noisy",
      agent_run_id: "ar-x",
      output_kind: "nonreview",
      raw_output: "plain prose",
    });
    assert.equal(r.schema_validation.ok, true);
    assert.equal(r.findings, undefined);
  });

  it("parses fenced JSON header for reviewer output", () => {
    const raw = [
      "intro line",
      "```json",
      JSON.stringify({
        verdict: "APPROVE",
        summary: "all good",
        findings: [
          {
            severity: "info",
            category: "style",
            summary: "minor nit",
          },
        ],
      }),
      "```",
      "trailing line",
    ].join("\n");
    const r = buildAgentResult({
      agent: "reviewer-1",
      agent_run_id: "ar-y",
      output_kind: "reviewer",
      raw_output: raw,
    });
    assert.equal(r.schema_validation.ok, true);
    assert.deepEqual(r.parsed_header?.["verdict"], "APPROVE");
    assert.equal(r.findings?.length, 1);
    assert.equal(r.findings?.[0]?.severity, "info");
  });

  it("flags schema-invalid reviewer output (no JSON header)", () => {
    const r = buildAgentResult({
      agent: "reviewer-2",
      agent_run_id: "ar-z",
      output_kind: "reviewer",
      raw_output: "no JSON anywhere here",
    });
    assert.equal(r.schema_validation.ok, false);
    if (r.schema_validation.ok === false) {
      assert.match(r.schema_validation.reason, /no-json-fence/);
    }
  });

  it("flags schema-invalid reviewer when severity is missing", () => {
    const raw = "```json\n" + JSON.stringify({
      verdict: "APPROVE",
      findings: [{ category: "x", summary: "no severity" }],
    }) + "\n```";
    const r = buildAgentResult({
      agent: "reviewer-3",
      agent_run_id: "ar-w",
      output_kind: "reviewer",
      raw_output: raw,
    });
    assert.equal(r.schema_validation.ok, false);
  });
});

// ============================================================================
// persistAgentResult
// ============================================================================

describe("persistAgentResult — four output_kind paths", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("nonreview: writes agent_records + counters only (no findings, no verdict)", async () => {
    await seedBaseline(projectDir);
    await seedPending(projectDir, "ar-nr-1", "nr-agent");

    const persistNow = captureNow();
    await withStateTransaction(projectDir, persistNow, async (tx) => {
      await persistAgentResult(tx, {
        result: {
          agent: "nr-agent",
          agent_run_id: "ar-nr-1",
          output: "narrative output",
          schema_validation: { ok: true },
          tokens: { in: 11, out: 22, cached: 3 },
        },
        output_kind: "nonreview",
        phase: "p1",
        model: "default",
      });
    });

    const checkNow = captureNow();
    const state = await withStateTransaction(projectDir, checkNow, (tx) => loadState(tx));
    assert.equal(state.agents_count, 1);
    assert.equal(state.total_tokens_in, 11);
    assert.equal(state.total_tokens_out, 22);
    assert.equal(state.total_tokens_cached, 3);
    assert.equal(state.pending_agents.length, 0);
    assert.equal(state.agent_verdicts.length, 0);
  });

  it("reviewer: persists findings + agent_verdicts with correct counts", async () => {
    await seedBaseline(projectDir);
    await seedPending(projectDir, "ar-rev-1", "rev-agent");

    const persistNow = captureNow();
    await withStateTransaction(projectDir, persistNow, async (tx) => {
      await persistAgentResult(tx, {
        result: {
          agent: "rev-agent",
          agent_run_id: "ar-rev-1",
          output: "...",
          parsed_header: { verdict: "REQUEST_CHANGES", summary: "two issues" },
          schema_validation: { ok: true },
          findings: [
            {
              schema_version: "1.0",
              id: "f-2026-05-28-aaaaaa",
              agent: "rev-agent",
              iteration: 1,
              task_id: "t-2026-05-28-persist",
              file: "src/foo.ts",
              line_start: 10,
              line_end: 12,
              severity: "blocking",
              category: "correctness",
              proposed_new_category: null,
              pattern_id: null,
              summary: "buggy",
              evidence_excerpt: null,
              suggested_fix: null,
              status: "open",
              ref_rule_id: null,
            },
            {
              schema_version: "1.0",
              id: "f-2026-05-28-bbbbbb",
              agent: "rev-agent",
              iteration: 1,
              task_id: "t-2026-05-28-persist",
              file: "src/foo.ts",
              line_start: 20,
              line_end: 20,
              severity: "warn",
              category: "style",
              proposed_new_category: null,
              pattern_id: null,
              summary: "warn-level nit",
              evidence_excerpt: null,
              suggested_fix: null,
              status: "open",
              ref_rule_id: null,
            },
          ],
          tokens: { in: 1, out: 2 },
        },
        output_kind: "reviewer",
        phase: "p1",
        model: "default",
      });
    });

    const checkNow = captureNow();
    const state = await withStateTransaction(projectDir, checkNow, (tx) => loadState(tx));
    assert.equal(state.agent_verdicts.length, 1);
    const verdict = state.agent_verdicts[0];
    assert.ok(verdict);
    assert.equal(verdict?.verdict, "REQUEST_CHANGES");
    assert.equal(verdict?.blocking_issues, 1);
    assert.equal(verdict?.warn_issues, 1);
    assert.equal(verdict?.info_issues, 0);

    const findingsCheckNow = captureNow();
    const findingsCount = await withStateTransaction(projectDir, findingsCheckNow, async (tx) => {
      const row = await tx.queryRow<{ n: number }>(
        "SELECT count(*) AS n FROM findings",
      );
      return Number(row?.n ?? 0);
    });
    assert.equal(findingsCount, 2);
  });

  it("validator: same shape as reviewer (verdict row + findings)", async () => {
    await seedBaseline(projectDir);
    await seedPending(projectDir, "ar-val-1", "val-agent");

    const persistNow = captureNow();
    await withStateTransaction(projectDir, persistNow, async (tx) => {
      await persistAgentResult(tx, {
        result: {
          agent: "val-agent",
          agent_run_id: "ar-val-1",
          output: "...",
          parsed_header: { verdict: "PASS", findings: [] },
          schema_validation: { ok: true },
          findings: [],
        },
        output_kind: "validator",
        phase: "p1",
        model: null,
      });
    });

    const state = await withStateTransaction(projectDir, captureNow(), (tx) => loadState(tx));
    assert.equal(state.agent_verdicts.length, 1);
    assert.equal(state.agent_verdicts[0]?.verdict, "PASS");
  });

  it("classifier: merges parsed_header into pipeline_state.decisions", async () => {
    await seedBaseline(projectDir);
    await seedPending(projectDir, "ar-cls-1", "cls-agent");

    const persistNow = captureNow();
    await withStateTransaction(projectDir, persistNow, async (tx) => {
      await persistAgentResult(tx, {
        result: {
          agent: "cls-agent",
          agent_run_id: "ar-cls-1",
          output: "{...}",
          parsed_header: {
            complexity: "medium",
            change_kind: "refactor",
            verdict: "ignored",  // verdict / summary / findings skipped during merge
            summary: "ignored",
            findings: [],
          },
          schema_validation: { ok: true },
        },
        output_kind: "classifier",
        phase: "p1",
        model: "default",
      });
    });

    const state = await withStateTransaction(projectDir, captureNow(), (tx) => loadState(tx));
    assert.equal(state.decisions["complexity"], "medium");
    assert.equal(state.decisions["change_kind"], "refactor");
    assert.equal(state.decisions["verdict"], undefined);
    assert.equal(state.decisions["summary"], undefined);
    assert.equal(state.decisions["findings"], undefined);
  });

  it("classifier: promotes a derived task_short to the first-class column", async () => {
    await seedBaseline(projectDir);
    await seedPending(projectDir, "ar-cls-short", "cls-agent");

    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      await persistAgentResult(tx, {
        result: {
          agent: "cls-agent",
          agent_run_id: "ar-cls-short",
          output: "{...}",
          parsed_header: {
            complexity: "medium",
            task_short: "shared-link-folder-open-regression-fix",
          },
          schema_validation: { ok: true },
        },
        output_kind: "classifier",
        phase: "p1",
        model: "default",
      });
    });

    const state = await withStateTransaction(projectDir, captureNow(), (tx) => loadState(tx));
    // The column is now populated (the prompt renderer + archive index read it)...
    assert.equal(state.task_short, "shared-link-folder-open-regression-fix");
    // ...and the value also stays in decisions (additive — no reader regresses).
    assert.equal(state.decisions["task_short"], "shared-link-folder-open-regression-fix");
  });

  it("classifier: an explicit create-time task_short label is not overwritten", async () => {
    // Seed with an explicit operator-supplied label in the column.
    const now = captureNow();
    await withStateTransaction(projectDir, now, async (tx) => {
      await tx.exec(
        "INSERT INTO pipeline_state (id, schema_version, project_dir, bundle, " +
          "task, task_short, task_id, driver_state_id, status, started_at, decisions) " +
          "VALUES (1, '3.0.0', ?, 'stub-bundle', 'persist fixture', " +
          "'operator-chosen-label', 't-2026-06-03-x', 'd-x', 'in_progress', ?, '{}')",
        [projectDir, now],
      );
      await tx.exec("INSERT INTO driver_state (id, flow_name, step_index, complete) VALUES (1, 'default', 0, 0)");
      await tx.exec("INSERT INTO pipeline_counters (id) VALUES (1)");
      await tx.exec("INSERT INTO phases (name, status, updated_at) VALUES ('p1', 'in_progress', ?)", [now]);
    });
    await seedPending(projectDir, "ar-cls-keep", "cls-agent");

    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      await persistAgentResult(tx, {
        result: {
          agent: "cls-agent",
          agent_run_id: "ar-cls-keep",
          output: "{...}",
          parsed_header: { task_short: "classifier-derived-label" },
          schema_validation: { ok: true },
        },
        output_kind: "classifier",
        phase: "p1",
        model: "default",
      });
    });

    const state = await withStateTransaction(projectDir, captureNow(), (tx) => loadState(tx));
    assert.equal(state.task_short, "operator-chosen-label");
  });

  it("classifier: throws STATE_CORRUPT and rolls back on an unparseable decisions blob", async () => {
    await seedBaseline(projectDir);
    await seedPending(projectDir, "ar-cls-bad", "cls-agent");

    // Force an unparseable blob past the json_valid CHECK the way real
    // tampering / backend skew would. The guard under test is the READER,
    // not the write-time constraint, so we bypass the constraint to set up.
    const db = openDb(projectDir);
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.prepare("UPDATE pipeline_state SET decisions = ? WHERE id = 1").run("not-json{");
    db.exec("PRAGMA ignore_check_constraints = OFF");

    await assert.rejects(
      withStateTransaction(projectDir, captureNow(), async (tx) => {
        await persistAgentResult(tx, {
          result: {
            agent: "cls-agent",
            agent_run_id: "ar-cls-bad",
            output: "{...}",
            parsed_header: { complexity: "high" },
            schema_validation: { ok: true },
          },
          output_kind: "classifier",
          phase: "p1",
          model: null,
        });
      }),
      (err: unknown) => err instanceof KernelError && err.code === "STATE_CORRUPT",
    );

    // The whole delivery rolled back: the corrupt blob is untouched (NOT
    // overwritten with `{}` or the merged header), the pending row still
    // stands, and counters were not bumped. Read through the direct
    // connection — a withStateTransaction commit now also fails loud on the
    // corrupt blob (its invariant pass loads state), which is the same
    // fail-closed contract, just not what we want to assert against here.
    const decRow = db
      .prepare("SELECT decisions FROM pipeline_state WHERE id = 1")
      .get() as { decisions: string };
    const pendRow = db
      .prepare("SELECT count(*) AS n FROM pending_agents WHERE agent_run_id = 'ar-cls-bad'")
      .get() as { n: number };
    const cntRow = db
      .prepare("SELECT agents_count FROM pipeline_counters WHERE id = 1")
      .get() as { agents_count: number };
    assert.equal(decRow.decisions, "not-json{");
    assert.equal(Number(pendRow.n), 1);
    assert.equal(Number(cntRow.agents_count), 0);
  });

  it("schema-invalid result: persists agent_records but skips findings/verdict", async () => {
    await seedBaseline(projectDir);
    await seedPending(projectDir, "ar-rev-bad", "rev-agent");

    const persistNow = captureNow();
    await withStateTransaction(projectDir, persistNow, async (tx) => {
      await persistAgentResult(tx, {
        result: {
          agent: "rev-agent",
          agent_run_id: "ar-rev-bad",
          output: "no JSON header here",
          schema_validation: { ok: false, reason: "no-json-fence" },
        },
        output_kind: "reviewer",
        phase: "p1",
        model: null,
      });
    });

    const state = await withStateTransaction(projectDir, captureNow(), (tx) => loadState(tx));
    assert.equal(state.agents_count, 1); // record was persisted for forensics
    assert.equal(state.agent_verdicts.length, 0); // no verdict row
    const findingsCount = await withStateTransaction(projectDir, captureNow(), async (tx) => {
      const row = await tx.queryRow<{ n: number }>(
        "SELECT count(*) AS n FROM findings",
      );
      return Number(row?.n ?? 0);
    });
    assert.equal(findingsCount, 0);
  });

  it("token roll-up is additive across multiple results", async () => {
    await seedBaseline(projectDir);
    await seedPending(projectDir, "ar-1", "a");
    await seedPending(projectDir, "ar-2", "a");

    for (const id of ["ar-1", "ar-2"]) {
      await withStateTransaction(projectDir, captureNow(), async (tx) => {
        await persistAgentResult(tx, {
          result: {
            agent: "a",
            agent_run_id: id,
            output: "x",
            schema_validation: { ok: true },
            tokens: { in: 10, out: 5, cached: 1 },
          },
          output_kind: "nonreview",
          phase: "p1",
          model: null,
        });
      });
    }

    const state = await withStateTransaction(projectDir, captureNow(), (tx) => loadState(tx));
    assert.equal(state.total_tokens_in, 20);
    assert.equal(state.total_tokens_out, 10);
    assert.equal(state.total_tokens_cached, 2);
    assert.equal(state.agents_count, 2);
  });

  it("refuses an undeclared output_kind with VOCAB_UNKNOWN and lands no row", async () => {
    await seedBaseline(projectDir);
    await seedPending(projectDir, "ar-bad-kind", "weird-agent");

    await assert.rejects(
      withStateTransaction(projectDir, captureNow(), async (tx) => {
        await persistAgentResult(tx, {
          result: {
            agent: "weird-agent",
            agent_run_id: "ar-bad-kind",
            output: "x",
            schema_validation: { ok: true },
            tokens: { in: 1, out: 1 },
          },
          output_kind: "totally-made-up-kind",
          phase: "p1",
          model: null,
          vocabularies: kernelDefaultVocabularies(),
        });
      }),
      (err: unknown) => err instanceof KernelError && err.code === "VOCAB_UNKNOWN",
    );

    // The refusal fires before any write and rolls the whole delivery
    // back: no agent_records row, the pending row still stands, counters
    // untouched. Read through the direct connection (the tx rolled back).
    const db = openDb(projectDir);
    const rec = db
      .prepare("SELECT COUNT(*) AS n FROM agent_records")
      .get() as { n: number };
    const pend = db
      .prepare("SELECT COUNT(*) AS n FROM pending_agents WHERE agent_run_id = 'ar-bad-kind'")
      .get() as { n: number };
    const cnt = db
      .prepare("SELECT agents_count FROM pipeline_counters WHERE id = 1")
      .get() as { agents_count: number };
    assert.equal(Number(rec.n), 0);
    assert.equal(Number(pend.n), 1);
    assert.equal(Number(cnt.agents_count), 0);
  });

  it("accepts a kernel-default output_kind when vocabularies are supplied", async () => {
    await seedBaseline(projectDir);
    await seedPending(projectDir, "ar-ok-kind", "nr-agent");

    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      await persistAgentResult(tx, {
        result: {
          agent: "nr-agent",
          agent_run_id: "ar-ok-kind",
          output: "x",
          schema_validation: { ok: true },
          tokens: { in: 4, out: 5 },
        },
        output_kind: "nonreview",
        phase: "p1",
        model: null,
        vocabularies: kernelDefaultVocabularies(),
      });
    });

    const state = await withStateTransaction(projectDir, captureNow(), (tx) => loadState(tx));
    assert.equal(state.agents_count, 1);
    assert.equal(state.pending_agents.length, 0);
  });
});

// ============================================================================
// Finding identity — server-minted, collision-proof across agents
// ============================================================================

describe("persistAgentResult — finding id is server-minted", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  function findingWithId(agent: string, id: string) {
    return {
      schema_version: "1.0",
      id,
      agent,
      iteration: 1,
      task_id: "t-2026-05-28-persist",
      file: "src/foo.ts",
      line_start: 1,
      line_end: 2,
      severity: "warn" as const,
      category: "style",
      proposed_new_category: null,
      pattern_id: null,
      summary: "nit",
      evidence_excerpt: null,
      suggested_fix: null,
      status: "open" as const,
      ref_rule_id: null,
    };
  }

  // Two agents emit the SAME client-supplied finding id (the cargo-culted
  // example suffix). The server mints fresh ids, so both deliveries persist
  // without a PRIMARY KEY collision and two distinct rows land. With the old
  // "keep the client id when present" branch the second INSERT collides and
  // the whole batch tx rolls back — this reddens on that revert.
  it("two agents emitting the same client id do NOT collide — both findings persist", async () => {
    await seedBaseline(projectDir);
    await seedPending(projectDir, "ar-c-1", "logic-reviewer");
    await seedPending(projectDir, "ar-c-2", "performance");

    const COLLIDING = "f-2026-05-28-a1b2c3";

    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      await persistAgentResult(tx, {
        result: {
          agent: "logic-reviewer",
          agent_run_id: "ar-c-1",
          output: "...",
          parsed_header: { verdict: "APPROVE", findings: [] },
          schema_validation: { ok: true },
          findings: [findingWithId("logic-reviewer", COLLIDING)],
        },
        output_kind: "reviewer",
        phase: "p1",
        model: null,
      });
    });

    // Second agent reuses the exact same finding id — must not throw.
    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      await persistAgentResult(tx, {
        result: {
          agent: "performance",
          agent_run_id: "ar-c-2",
          output: "...",
          parsed_header: { verdict: "APPROVE", findings: [] },
          schema_validation: { ok: true },
          findings: [findingWithId("performance", COLLIDING)],
        },
        output_kind: "reviewer",
        phase: "p1",
        model: null,
      });
    });

    const ids = await withStateTransaction(projectDir, captureNow(), async (tx) => {
      const rows = await tx.queryAll<{ id: string }>("SELECT id FROM findings ORDER BY id");
      return rows.map((r) => String(r.id));
    });
    assert.equal(ids.length, 2, "both findings should persist");
    assert.notEqual(ids[0], ids[1], "server-minted ids must be distinct");
    for (const id of ids) {
      assert.match(id, /^f-\d{4}-\d{2}-\d{2}-[a-z0-9]{6}$/);
      assert.notEqual(id, COLLIDING, "the client-supplied id must not be used verbatim");
    }
  });
});

// ============================================================================
// Verdict ⟺ findings cross-check (A3 — data hygiene)
// ============================================================================

describe("persistAgentResult — verdict ⟺ findings cross-check", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  // A reviewer reports REQUEST_CHANGES but every finding is non-blocking —
  // a self-contradiction against the bundle's "REQUEST_CHANGES iff a
  // blocking finding" rule. The stored verdict is normalized to the
  // findings-derived APPROVE so it stops misrepresenting a clean result.
  // Reverting the cross-check stores REQUEST_CHANGES verbatim → reddens.
  it("normalizes REQUEST_CHANGES-with-zero-blockers to APPROVE", async () => {
    await seedBaseline(projectDir);
    await seedPending(projectDir, "ar-style-1", "style-reviewer");

    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      await persistAgentResult(tx, {
        result: {
          agent: "style-reviewer",
          agent_run_id: "ar-style-1",
          output: "...",
          parsed_header: { verdict: "REQUEST_CHANGES", summary: "nits only" },
          schema_validation: { ok: true },
          findings: [
            {
              schema_version: "1.0",
              id: "",
              agent: "style-reviewer",
              iteration: 1,
              task_id: "t-2026-05-28-persist",
              file: "src/a.ts",
              line_start: 1,
              line_end: 1,
              severity: "warn",
              category: "style",
              proposed_new_category: null,
              pattern_id: null,
              summary: "trailing whitespace",
              evidence_excerpt: null,
              suggested_fix: null,
              status: "open",
              ref_rule_id: null,
            },
          ],
        },
        output_kind: "reviewer",
        phase: "p1",
        model: null,
      });
    });

    const state = await withStateTransaction(projectDir, captureNow(), (tx) => loadState(tx));
    assert.equal(state.agent_verdicts.length, 1);
    assert.equal(state.agent_verdicts[0]?.verdict, "APPROVE", "verdict normalized to the findings");
    assert.equal(state.agent_verdicts[0]?.blocking_issues, 0);
  });

  // The honest case is untouched: REQUEST_CHANGES with a real blocking
  // finding is stored verbatim (it agrees with the findings).
  it("leaves REQUEST_CHANGES intact when a blocking finding is present", async () => {
    await seedBaseline(projectDir);
    await seedPending(projectDir, "ar-logic-1", "logic-reviewer");

    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      await persistAgentResult(tx, {
        result: {
          agent: "logic-reviewer",
          agent_run_id: "ar-logic-1",
          output: "...",
          parsed_header: { verdict: "REQUEST_CHANGES", summary: "real bug" },
          schema_validation: { ok: true },
          findings: [
            {
              schema_version: "1.0",
              id: "",
              agent: "logic-reviewer",
              iteration: 1,
              task_id: "t-2026-05-28-persist",
              file: "src/a.ts",
              line_start: 1,
              line_end: 1,
              severity: "blocking",
              category: "correctness",
              proposed_new_category: null,
              pattern_id: null,
              summary: "null deref",
              evidence_excerpt: null,
              suggested_fix: null,
              status: "open",
              ref_rule_id: null,
            },
          ],
        },
        output_kind: "reviewer",
        phase: "p1",
        model: null,
      });
    });

    const state = await withStateTransaction(projectDir, captureNow(), (tx) => loadState(tx));
    assert.equal(state.agent_verdicts[0]?.verdict, "REQUEST_CHANGES");
    assert.equal(state.agent_verdicts[0]?.blocking_issues, 1);
  });
});
