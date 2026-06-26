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
  withStateTransaction,
} from "../src/state.js";
import { buildVocabularies } from "../src/vocabularies.js";
import type { Bundle } from "../src/types/bundle.js";
import type { NowToken } from "../src/types/now.js";
import type {
  Policy,
  PolicyName,
} from "../src/types/policy.js";
import type { LLMProvider } from "../src/types/provider.js";
import type { Registry } from "../src/types/registry.js";
import type { GateRole } from "../src/types/row-types.js";
import type { PipelineState } from "../src/types/state.js";

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "loom-findings-access-"));
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
    description: "findings-access fixture",
    phases: ["p1", "p2"],
    default_flow: "default",
    default_gate_policies: { plan: "human" } as Record<GateRole, PolicyName>,
    gate_roles: {},
    agents: [],
    stages: {},
    flows: { default: [] },
    hooks: [],
    invariants: [],
  };
  const policyFactories = new Map<PolicyName, () => Policy>([
    ["human", humanFactory],
  ]);
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
    policyFactories,
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
        "findings fixture",
        "t-2026-05-28-findings",
        "d-findings",
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
      "INSERT INTO phases (name, status, skipped_reason, updated_at) VALUES ('p1', 'pending', NULL, ?)",
      [now],
    );
    await tx.exec(
      "INSERT INTO phases (name, status, skipped_reason, updated_at) VALUES ('p2', 'pending', NULL, ?)",
      [now],
    );
  });
  return now;
}

async function seedFindings(
  projectDir: string,
  now: NowToken,
  rows: Array<{
    id: string;
    agent: string;
    iteration: number;
    phase: string;
    severity: "blocking" | "warn" | "info";
    category?: string;
    status?: "open" | "fixed" | "accepted_by_human" | "dismissed";
    summary?: string;
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
          "t-2026-05-28-findings",
          r.agent,
          r.iteration,
          r.phase,
          r.severity,
          r.category ?? "test",
          r.summary ?? `${r.severity} finding`,
          r.status ?? "open",
          now,
        ],
      );
    }
  });
}

async function seedAgentRecord(
  projectDir: string,
  now: NowToken,
  row: { agent: string; agent_run_id: string; phase: string; output_kind: string },
): Promise<void> {
  await withStateTransaction(projectDir, now, async (tx) => {
    await tx.exec(
      "INSERT INTO agent_records (phase, agent, agent_run_id, model, output_kind, " +
        "tokens_in, tokens_out, tokens_cached, recorded_at) " +
        "VALUES (?, ?, ?, NULL, ?, NULL, NULL, NULL, ?)",
      [row.phase, row.agent, row.agent_run_id, row.output_kind, now],
    );
  });
}

async function seedAudit(
  projectDir: string,
  now: NowToken,
  rows: Array<{ ts: string; type: string }>,
): Promise<void> {
  await withStateTransaction(projectDir, now, async (tx) => {
    for (const r of rows) {
      await tx.exec(
        "INSERT INTO audit (ts, type, task_id, driver_state_id, payload, verdict) " +
          "VALUES (?, ?, ?, ?, '{}', 'ok')",
        [r.ts, r.type, "t-2026-05-28-findings", "d-findings"],
      );
    }
  });
}

function buildInMemoryState(projectDir: string, now: NowToken): PipelineState {
  return {
    schema_version: "3.0.0",
    task_id: "t-2026-05-28-findings",
    driver_state_id: "d-findings",
    project_dir: projectDir,
    bundle: "stub-bundle",
    task: "findings fixture",
    task_short: null,
    owner_id: null,
    status: "in_progress",
    verdict: null,
    work_result: null,
    started_at: now,
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
      {
        name: "p2",
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

describe("StageContext.findings — real query against pre-materialized snapshot", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("countBlocking({phase}) returns the count of blocking findings in that phase", async () => {
    const now = await seedBaseline(projectDir);
    await seedFindings(projectDir, now, [
      { id: "f-1", agent: "rev", iteration: 1, phase: "p1", severity: "blocking" },
      { id: "f-2", agent: "rev", iteration: 1, phase: "p1", severity: "blocking" },
      { id: "f-3", agent: "rev", iteration: 1, phase: "p1", severity: "warn" },
      { id: "f-4", agent: "rev", iteration: 1, phase: "p2", severity: "blocking" },
    ]);

    const registry = buildRegistry();
    const state = buildInMemoryState(projectDir, now);
    const checkNow = captureNow();
    const blockerCount = await withStateTransaction(projectDir, checkNow, async (tx) => {
      const { ctx } = await buildStageContext(state, registry, tx);
      return ctx.findings.countBlocking({ phase: "p1" });
    });

    assert.equal(blockerCount, 2);
  });

  it("query({severity: ['blocking']}) returns matching rows", async () => {
    const now = await seedBaseline(projectDir);
    await seedFindings(projectDir, now, [
      { id: "f-a", agent: "rev", iteration: 1, phase: "p1", severity: "blocking" },
      { id: "f-b", agent: "rev", iteration: 1, phase: "p1", severity: "warn" },
      { id: "f-c", agent: "rev", iteration: 1, phase: "p1", severity: "blocking" },
    ]);

    const registry = buildRegistry();
    const state = buildInMemoryState(projectDir, now);
    const checkNow = captureNow();
    const blockingIds = await withStateTransaction(projectDir, checkNow, async (tx) => {
      const { ctx } = await buildStageContext(state, registry, tx);
      return ctx.findings
        .query({ severity: ["blocking"] })
        .map((f) => f.id)
        .sort();
    });

    assert.deepEqual(blockingIds, ["f-a", "f-c"]);
  });

  it("query({agent}) narrows by agent name", async () => {
    const now = await seedBaseline(projectDir);
    await seedFindings(projectDir, now, [
      { id: "f-1", agent: "rev-1", iteration: 1, phase: "p1", severity: "blocking" },
      { id: "f-2", agent: "rev-2", iteration: 1, phase: "p1", severity: "blocking" },
    ]);

    const registry = buildRegistry();
    const state = buildInMemoryState(projectDir, now);
    const checkNow = captureNow();
    const rev1 = await withStateTransaction(projectDir, checkNow, async (tx) => {
      const { ctx } = await buildStageContext(state, registry, tx);
      return ctx.findings.query({ agent: "rev-1" }).map((f) => f.id);
    });

    assert.deepEqual(rev1, ["f-1"]);
  });

  it("query({status}) narrows by status set", async () => {
    const now = await seedBaseline(projectDir);
    await seedFindings(projectDir, now, [
      { id: "f-open", agent: "rev", iteration: 1, phase: "p1", severity: "blocking", status: "open" },
      { id: "f-fixed", agent: "rev", iteration: 1, phase: "p1", severity: "blocking", status: "fixed" },
      { id: "f-dismissed", agent: "rev", iteration: 1, phase: "p1", severity: "blocking", status: "dismissed" },
    ]);

    const registry = buildRegistry();
    const state = buildInMemoryState(projectDir, now);
    const checkNow = captureNow();
    const ids = await withStateTransaction(projectDir, checkNow, async (tx) => {
      const { ctx } = await buildStageContext(state, registry, tx);
      return ctx.findings
        .query({ status: ["open", "dismissed"] })
        .map((f) => f.id)
        .sort();
    });

    assert.deepEqual(ids, ["f-dismissed", "f-open"]);
  });

  it("queryByPhase(phase) returns every finding in that phase", async () => {
    const now = await seedBaseline(projectDir);
    await seedFindings(projectDir, now, [
      { id: "f-1", agent: "rev", iteration: 1, phase: "p1", severity: "info" },
      { id: "f-2", agent: "rev", iteration: 1, phase: "p1", severity: "warn" },
      { id: "f-3", agent: "rev", iteration: 1, phase: "p2", severity: "blocking" },
    ]);

    const registry = buildRegistry();
    const state = buildInMemoryState(projectDir, now);
    const checkNow = captureNow();
    const ids = await withStateTransaction(projectDir, checkNow, async (tx) => {
      const { ctx } = await buildStageContext(state, registry, tx);
      return ctx.findings.queryByPhase("p1").map((f) => f.id).sort();
    });

    assert.deepEqual(ids, ["f-1", "f-2"]);
  });

  it("countBlocking({}) counts across every phase when no phase filter is supplied", async () => {
    const now = await seedBaseline(projectDir);
    await seedFindings(projectDir, now, [
      { id: "f-1", agent: "rev", iteration: 1, phase: "p1", severity: "blocking" },
      { id: "f-2", agent: "rev", iteration: 1, phase: "p2", severity: "blocking" },
      { id: "f-3", agent: "rev", iteration: 1, phase: "p2", severity: "warn" },
    ]);

    const registry = buildRegistry();
    const state = buildInMemoryState(projectDir, now);
    const checkNow = captureNow();
    const total = await withStateTransaction(projectDir, checkNow, async (tx) => {
      const { ctx } = await buildStageContext(state, registry, tx);
      return ctx.findings.countBlocking();
    });

    assert.equal(total, 2);
  });
});

describe("StageContext.audit_query — recent rows", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("recent({type}) returns matching rows in reverse-chronological order", async () => {
    const now = await seedBaseline(projectDir);
    await seedAudit(projectDir, now, [
      { ts: "2026-05-27T10:00:00.000Z", type: "agent-spawn" },
      { ts: "2026-05-28T11:00:00.000Z", type: "agent-spawn" },
      { ts: "2026-05-28T12:00:00.000Z", type: "gate-decision" },
      { ts: "2026-05-28T13:00:00.000Z", type: "agent-spawn" },
    ]);

    const registry = buildRegistry();
    const state = buildInMemoryState(projectDir, now);
    const checkNow = captureNow();
    const tsList = await withStateTransaction(projectDir, checkNow, async (tx) => {
      const { ctx } = await buildStageContext(state, registry, tx);
      return ctx.audit_query
        .recent({ type: "agent-spawn" })
        .map((r) => r.ts);
    });

    // SELECT ... ORDER BY id DESC — IDs are AUTOINCREMENT, so the last
    // inserted agent-spawn row appears first.
    assert.deepEqual(tsList, [
      "2026-05-28T13:00:00.000Z",
      "2026-05-28T11:00:00.000Z",
      "2026-05-27T10:00:00.000Z",
    ]);
  });

  it("recent({limit}) truncates to the first N rows after the DESC sort", async () => {
    const now = await seedBaseline(projectDir);
    await seedAudit(projectDir, now, [
      { ts: "2026-05-27T10:00:00.000Z", type: "agent-spawn" },
      { ts: "2026-05-28T11:00:00.000Z", type: "agent-spawn" },
      { ts: "2026-05-28T12:00:00.000Z", type: "agent-spawn" },
      { ts: "2026-05-28T13:00:00.000Z", type: "agent-spawn" },
    ]);

    const registry = buildRegistry();
    const state = buildInMemoryState(projectDir, now);
    const checkNow = captureNow();
    const tsList = await withStateTransaction(projectDir, checkNow, async (tx) => {
      const { ctx } = await buildStageContext(state, registry, tx);
      return ctx.audit_query.recent({ limit: 2 }).map((r) => r.ts);
    });

    // Two most-recent only — DESC truncated at 2.
    assert.deepEqual(tsList, [
      "2026-05-28T13:00:00.000Z",
      "2026-05-28T12:00:00.000Z",
    ]);
  });

  it("recent({since}) filters to rows with ts >= since", async () => {
    const now = await seedBaseline(projectDir);
    await seedAudit(projectDir, now, [
      { ts: "2026-05-27T10:00:00.000Z", type: "agent-spawn" },
      { ts: "2026-05-28T11:00:00.000Z", type: "agent-spawn" },
      { ts: "2026-05-28T13:00:00.000Z", type: "agent-spawn" },
    ]);

    const registry = buildRegistry();
    const state = buildInMemoryState(projectDir, now);
    const checkNow = captureNow();
    const tsList = await withStateTransaction(projectDir, checkNow, async (tx) => {
      const { ctx } = await buildStageContext(state, registry, tx);
      return ctx.audit_query
        .recent({ since: "2026-05-28T00:00:00.000Z" })
        .map((r) => r.ts);
    });

    assert.deepEqual(tsList, [
      "2026-05-28T13:00:00.000Z",
      "2026-05-28T11:00:00.000Z",
    ]);
  });

  it("recent({}) with no filter returns every row, DESC by id", async () => {
    const now = await seedBaseline(projectDir);
    await seedAudit(projectDir, now, [
      { ts: "2026-05-27T10:00:00.000Z", type: "a" },
      { ts: "2026-05-28T11:00:00.000Z", type: "b" },
    ]);

    const registry = buildRegistry();
    const state = buildInMemoryState(projectDir, now);
    const checkNow = captureNow();
    const types = await withStateTransaction(projectDir, checkNow, async (tx) => {
      const { ctx } = await buildStageContext(state, registry, tx);
      return ctx.audit_query.recent({}).map((r) => r.type);
    });

    assert.deepEqual(types, ["b", "a"]);
  });
});

describe("StageContext.agents_query — agent_records snapshot", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("query({agent}) returns matching agent_records", async () => {
    const now = await seedBaseline(projectDir);
    await seedAgentRecord(projectDir, now, {
      agent: "rev-agent",
      agent_run_id: "ar-1",
      phase: "p1",
      output_kind: "reviewer",
    });
    await seedAgentRecord(projectDir, now, {
      agent: "other-agent",
      agent_run_id: "ar-2",
      phase: "p1",
      output_kind: "nonreview",
    });

    const registry = buildRegistry();
    const state = buildInMemoryState(projectDir, now);
    const checkNow = captureNow();
    const matches = await withStateTransaction(projectDir, checkNow, async (tx) => {
      const { ctx } = await buildStageContext(state, registry, tx);
      return ctx.agents_query
        .query({ agent: "rev-agent" })
        .map((r) => r.agent_run_id);
    });

    assert.deepEqual(matches, ["ar-1"]);
  });
});
