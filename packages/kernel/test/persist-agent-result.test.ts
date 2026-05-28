import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { buildAgentResult } from "../src/lib/build-agent-result.js";
import { persistAgentResult } from "../src/lib/persist-agent-result.js";
import { _resetInvariantsForTest } from "../src/invariants.js";
import {
  captureNow,
  closeDb,
  loadState,
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
});
