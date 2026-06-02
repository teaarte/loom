import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  KernelError,
  captureNow,
  closeDb,
  loadState,
  openDb,
  withStateTransaction,
} from "../src/state.js";
import type { NowToken } from "../src/types/now.js";
import type { PipelineState } from "../src/types/state.js";

// Each test creates an isolated project dir so the per-projectDir DB
// singleton never bleeds state across cases.
function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "loom-state-"));
}

function cleanup(projectDir: string): void {
  try { closeDb(projectDir); } catch { /* may have already closed */ }
  rmSync(projectDir, { recursive: true, force: true });
}

// Insert the canonical pipeline_state + driver_state baseline so
// loadState has something to materialize. Returns the NowToken used.
async function seedBaseline(projectDir: string): Promise<NowToken> {
  const now = captureNow();
  await withStateTransaction(projectDir, now, async (tx) => {
    await tx.exec(
      "INSERT INTO pipeline_state (id, schema_version, project_dir, bundle, " +
        "task, driver_state_id, status, started_at) " +
        "VALUES (1, ?, ?, ?, ?, ?, ?, ?)",
      [
        "3.0.0",
        projectDir,
        "code",
        "build a thing",
        "d-baseline",
        "in_progress",
        now,
      ],
    );
    await tx.exec(
      "INSERT INTO driver_state (id, flow_name, step_index, complete) " +
        "VALUES (1, 'simple', 0, 0)",
    );
    await tx.exec("INSERT INTO pipeline_counters (id) VALUES (1)");
  });
  return now;
}

describe("openDb", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("enables WAL journal mode", () => {
    const db = openDb(projectDir);
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    assert.equal(row.journal_mode, "wal");
  });

  it("creates every kernel-owned table on first open", () => {
    const db = openDb(projectDir);
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = rows.map((r) => r.name).sort();
    assert.deepEqual(
      names,
      [
        "agent_records",
        "agent_verdicts",
        "audit",
        "bypass_markers",
        "driver_state",
        "findings",
        "gates",
        "installed_extensions",
        "kernel_idempotency_ledger",
        "kernel_schema_versions",
        "pending_agents",
        "phases",
        "pipeline_counters",
        "pipeline_gate_counters",
        "pipeline_state",
      ],
    );
  });

  it("records the kernel schema version on first migration", () => {
    const db = openDb(projectDir);
    const rows = db
      .prepare("SELECT component, version FROM kernel_schema_versions ORDER BY component")
      .all() as { component: string; version: string }[];
    const components = rows.map((r) => r.component);
    assert.deepEqual(components, [
      "001-initial",
      "002-installed-extensions",
      "003-bypass-markers",
      "004-finding-supersede",
      "005-drop-stack-column",
    ]);
    for (const r of rows) assert.equal(r.version, "3.1.0");
  });

  it("returns the same Database instance across calls (singleton)", () => {
    const a = openDb(projectDir);
    const b = openDb(projectDir);
    assert.equal(a, b);
  });
});

describe("migration runner — idempotent", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("re-running migrations after close+reopen leaves one row per file", () => {
    openDb(projectDir);
    closeDb(projectDir);

    const db = openDb(projectDir);
    const rows = db
      .prepare("SELECT component FROM kernel_schema_versions ORDER BY component")
      .all() as { component: string }[];
    const components = rows.map((r) => r.component);
    assert.deepEqual(components, [
      "001-initial",
      "002-installed-extensions",
      "003-bypass-markers",
      "004-finding-supersede",
      "005-drop-stack-column",
    ]);
  });
});

describe("migration 005 — drop stack column", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("a fresh store has no `stack` column in pipeline_state", () => {
    const db = openDb(projectDir);
    const cols = (db.prepare("PRAGMA table_info(pipeline_state)").all() as { name: string }[])
      .map((r) => r.name);
    assert.ok(!cols.includes("stack"), "005 must leave a fresh store without the stack column");
  });

  it("migrates a pre-005 store forward: drops stack, preserves the row's other data", () => {
    // Hand-build a store at the pre-005 schema (pipeline_state carries the
    // stack column) with 001–004 already recorded, so the runner applies
    // ONLY 005 when the pool opens it. A populated stack value is discarded;
    // every other column survives the drop.
    const dbPath = join(projectDir, ".claude", "state.db");
    mkdirSync(join(projectDir, ".claude"), { recursive: true });
    const raw = new DatabaseSync(dbPath);
    raw.exec(
      "CREATE TABLE kernel_schema_versions (component TEXT PRIMARY KEY, " +
        "version TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    for (const c of [
      "001-initial",
      "002-installed-extensions",
      "003-bypass-markers",
      "004-finding-supersede",
    ]) {
      raw
        .prepare("INSERT INTO kernel_schema_versions VALUES (?, ?, ?)")
        .run(c, "3.0.0", "2026-06-02T00:00:00.000Z");
    }
    raw.exec(
      "CREATE TABLE pipeline_state (" +
        "id INTEGER PRIMARY KEY CHECK (id = 1), schema_version TEXT NOT NULL, " +
        "task_id TEXT, task TEXT NOT NULL, bundle TEXT NOT NULL, " +
        "stack TEXT CHECK (stack IS NULL OR json_valid(stack)), " +
        "force_used INTEGER NOT NULL DEFAULT 0)",
    );
    raw
      .prepare(
        "INSERT INTO pipeline_state (id, schema_version, task_id, task, bundle, stack, force_used) " +
          "VALUES (1, ?, ?, ?, ?, ?, 0)",
      )
      .run("3.0.0", "t-legacy", "legacy task", "code", JSON.stringify({ language: "typescript" }));
    raw.close();

    // Opening the pool runs the pending 005 against the existing store.
    const db = openDb(projectDir);
    const cols = (db.prepare("PRAGMA table_info(pipeline_state)").all() as { name: string }[])
      .map((r) => r.name);
    assert.ok(!cols.includes("stack"), "005 must drop the stack column on an existing store");

    const row = db
      .prepare("SELECT task_id, task, bundle FROM pipeline_state WHERE id = 1")
      .get() as { task_id: string; task: string; bundle: string };
    assert.equal(row.task_id, "t-legacy");
    assert.equal(row.task, "legacy task");
    assert.equal(row.bundle, "code");
  });
});

describe("withStateTransaction — round-trip", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("inserts a pipeline_state row and reads it back via loadState", async () => {
    const now = await seedBaseline(projectDir);

    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      const state = await loadState(tx);
      // Compile-time check: loadState() must return assignable to PipelineState.
      const _typed: PipelineState = state;
      assert.equal(_typed.schema_version, "3.0.0");
      assert.equal(_typed.bundle, "code");
      assert.equal(_typed.task, "build a thing");
      assert.equal(_typed.status, "in_progress");
      assert.equal(_typed.started_at, now);
      assert.equal(_typed.driver.flow_name, "simple");
      assert.equal(_typed.driver.step_index, 0);
      assert.equal(_typed.driver.complete, false);
      assert.deepEqual(_typed.phases, []);
      assert.deepEqual(_typed.gates, {});
      assert.deepEqual(_typed.gate_revisions, {});
      assert.equal(_typed.agents_count, 0);
      assert.equal(_typed.total_tokens_in, 0);
    });
  });

  it("rolls back on throw inside the callback", async () => {
    await seedBaseline(projectDir);

    await assert.rejects(
      withStateTransaction(projectDir, captureNow(), async (tx) => {
        await tx.exec(
          "UPDATE pipeline_state SET task = ? WHERE id = 1",
          ["mutated"],
        );
        throw new Error("nope");
      }),
      /nope/,
    );

    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      const state = await loadState(tx);
      assert.equal(state.task, "build a thing");
    });
  });
});

describe("withStateTransaction — JSON CHECK rollback", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("bad JSON write to decisions trips json_valid CHECK and rolls back", async () => {
    await seedBaseline(projectDir);

    // First, set a known-good decisions blob.
    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      await tx.exec(
        "UPDATE pipeline_state SET decisions = ? WHERE id = 1",
        [JSON.stringify({ ok: true })],
      );
    });

    await assert.rejects(
      withStateTransaction(projectDir, captureNow(), async (tx) => {
        // Bypass any JS-side parsing — write raw bad JSON via parameter
        // binding so the CHECK constraint is what trips, not parse error.
        await tx.exec(
          "UPDATE pipeline_state SET decisions = ? WHERE id = 1",
          ["not-json{"],
        );
      }),
      /CHECK|constraint|json/i,
    );

    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      const state = await loadState(tx);
      assert.deepEqual(state.decisions, { ok: true });
    });
  });
});

describe("withStateTransaction — cross-tx persistence", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("commits survive close + reopen of the cached singleton", async () => {
    await seedBaseline(projectDir);
    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      await tx.exec(
        "UPDATE pipeline_state SET task_short = ? WHERE id = 1",
        ["persisted"],
      );
    });

    // Drop the cached connection; the next openDb call must reach the
    // same on-disk file and see the committed value. Without this round
    // trip, an in-memory-only commit would slip through unnoticed.
    closeDb(projectDir);

    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      const state = await loadState(tx);
      assert.equal(state.task_short, "persisted");
    });
  });
});

describe("loadState — error paths", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("throws KernelError{STATE_NOT_INITIALIZED} on a fresh DB", async () => {
    openDb(projectDir);
    await assert.rejects(
      withStateTransaction(projectDir, captureNow(), async (tx) => {
        await loadState(tx);
      }),
      (err: unknown) => {
        assert.ok(err instanceof KernelError, `expected KernelError, got ${err}`);
        assert.equal((err as KernelError).code, "STATE_NOT_INITIALIZED");
        return true;
      },
    );
  });
});

describe("loadState — rich snapshot materialization", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("maps JSON columns, counters, phases, gates, verdicts, and pending_agents", async () => {
    const startedAt = await seedBaseline(projectDir);

    const seedNow = captureNow();
    await withStateTransaction(projectDir, seedNow, async (tx) => {
      // Promote the canonical row with non-trivial JSON / scalar fields.
      await tx.exec(
        "UPDATE pipeline_state SET " +
          "task_id = ?, task_short = ?, owner_id = ?, " +
          "gate_policies = ?, decisions = ?, bundle_state = ?, " +
          "files_created = ?, files_modified = ?, " +
          "pipeline_violation = ?, force_used = ? WHERE id = 1",
        [
          "t-2026-05-28-fixture",
          "rich-snapshot",
          "alice",
          JSON.stringify({ classify: "auto", plan: "human", final: "on-blockers" }),
          JSON.stringify({ refs_to_load: ["src/foo.ts"], change_kind: "feature" }),
          JSON.stringify({ extra: 42 }),
          JSON.stringify(["src/new.ts"]),
          JSON.stringify(["src/old.ts", "src/other.ts"]),
          "pending-cancel",
          1,
        ],
      );

      await tx.exec(
        "UPDATE driver_state SET step_index = 4, complete = 1, " +
          "pending_user_answer = ?, scratch = ? WHERE id = 1",
        [
          JSON.stringify({ gate: "gate-plan", message: "approve?" }),
          JSON.stringify({ replan_iters: 2 }),
        ],
      );

      await tx.exec(
        "UPDATE pipeline_counters SET agents_count = 7, " +
          "total_tokens_in = 1000, total_tokens_out = 500, " +
          "total_tokens_cached = 100 WHERE id = 1",
      );

      await tx.exec(
        "INSERT INTO pipeline_gate_counters (role, human_revisions, auto_rejections) VALUES (?, ?, ?), (?, ?, ?)",
        ["plan", 2, 0, "final", 0, 3],
      );

      // Phases referenced by agent_verdicts must exist via the FK on
      // agent_records — verdicts themselves don't FK, but a realistic
      // snapshot has both, so we seed both. `allow_empty` on the
      // completed phase declares it's legitimately agent-record-free
      // so the kernel completion-coverage invariant passes.
      await tx.exec(
        "INSERT INTO phases (name, status, phase_extension, updated_at) " +
          "VALUES (?, 'completed', ?, ?), (?, 'in_progress', NULL, ?)",
        [
          "context",
          JSON.stringify({ allow_empty: true }),
          seedNow,
          "planning",
          seedNow,
        ],
      );

      await tx.exec(
        "INSERT INTO gates (name, status, decided_by, feedback, decided_at) VALUES (?, ?, ?, ?, ?)",
        ["gate-plan", "approved", "human", "lgtm", seedNow],
      );

      await tx.exec(
        "INSERT INTO agent_verdicts (phase, agent, iteration, verdict, summary_line, " +
          "blocking_issues, warn_issues, info_issues, categories_seen, recorded_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "planning",
          "reviewer-architecture",
          1,
          "REQUEST_CHANGES",
          "two blocking issues",
          2,
          1,
          0,
          JSON.stringify(["race-condition", "auth-bypass"]),
          seedNow,
        ],
      );

      await tx.exec(
        "INSERT INTO pending_agents (agent_run_id, agent, phase, model, started_at) VALUES (?, ?, ?, ?, ?)",
        ["ar-fixture-0001", "reviewer-security", "planning", "balanced", seedNow],
      );
    });

    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      const state = await loadState(tx);

      // Scalars / JSON aggregate
      assert.equal(state.task_id, "t-2026-05-28-fixture");
      assert.equal(state.task_short, "rich-snapshot");
      assert.equal(state.owner_id, "alice");
      assert.equal(state.force_used, true);
      assert.equal(state.pipeline_violation, "pending-cancel");
      assert.equal(state.started_at, startedAt);
      assert.deepEqual(state.gate_policies, {
        classify: "auto",
        plan: "human",
        final: "on-blockers",
      });
      assert.deepEqual(state.decisions, {
        refs_to_load: ["src/foo.ts"],
        change_kind: "feature",
      });
      assert.deepEqual(state.bundle_state, { extra: 42 });
      assert.deepEqual(state.files_created, ["src/new.ts"]);
      assert.deepEqual(state.files_modified, ["src/old.ts", "src/other.ts"]);

      // Counters
      assert.equal(state.agents_count, 7);
      assert.equal(state.total_tokens_in, 1000);
      assert.equal(state.total_tokens_out, 500);
      assert.equal(state.total_tokens_cached, 100);
      assert.deepEqual(state.gate_revisions, { plan: 2, final: 0 });
      assert.deepEqual(state.gate_auto_rejections, { plan: 0, final: 3 });

      // Driver
      assert.equal(state.driver.step_index, 4);
      assert.equal(state.driver.complete, true);
      assert.deepEqual(state.driver.pending_user_answer, {
        gate: "gate-plan",
        message: "approve?",
      });
      assert.deepEqual(state.driver.scratch, { replan_iters: 2 });

      // Eager collections
      assert.equal(state.phases.length, 2);
      assert.equal(state.phases[0]?.name, "context");
      assert.equal(state.phases[0]?.status, "completed");
      assert.equal(state.phases[1]?.name, "planning");
      assert.equal(state.phases[1]?.status, "in_progress");

      assert.equal(Object.keys(state.gates).length, 1);
      assert.equal(state.gates["gate-plan"]?.status, "approved");
      assert.equal(state.gates["gate-plan"]?.decided_by, "human");
      assert.equal(state.gates["gate-plan"]?.feedback, "lgtm");

      assert.equal(state.agent_verdicts.length, 1);
      assert.equal(state.agent_verdicts[0]?.verdict, "REQUEST_CHANGES");
      assert.equal(state.agent_verdicts[0]?.blocking_issues, 2);
      assert.deepEqual(state.agent_verdicts[0]?.categories_seen, [
        "race-condition",
        "auth-bypass",
      ]);

      assert.equal(state.pending_agents.length, 1);
      assert.equal(state.pending_agents[0]?.agent_run_id, "ar-fixture-0001");
      assert.equal(state.pending_agents[0]?.phase, "planning");
      assert.equal(state.pending_agents[0]?.model, "balanced");
    });
  });
});

describe("withStateTransaction — invariant rollback", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("violation thrown by runInvariants rolls back the in-flight write", async () => {
    await seedBaseline(projectDir);

    // Insert a skipped phase without a skipped_reason — the kernel
    // shape invariant for skipped phases trips on this exact case.
    await assert.rejects(
      withStateTransaction(projectDir, captureNow(), async (tx) => {
        await tx.exec(
          "INSERT INTO phases (name, status, updated_at) VALUES (?, ?, ?)",
          ["planning", "skipped", captureNow()],
        );
      }),
      (err: unknown) => {
        assert.ok(err instanceof KernelError, `expected KernelError, got ${err}`);
        assert.equal((err as KernelError).code, "INVARIANT_VIOLATION");
        const detail = (err as KernelError).detail;
        assert.ok(detail !== undefined, "violation detail should be attached");
        return true;
      },
    );

    // The attempted write must be absent after the rollback —
    // loadState should still see zero phases.
    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      const row = await tx.queryRow<{ c: number }>(
        "SELECT COUNT(*) AS c FROM phases",
      );
      assert.equal(Number(row?.c), 0);
    });
  });
});

describe("STATE_BUSY surfacing", () => {
  let projectDir: string;
  beforeEach(() => { projectDir = freshProject(); });
  afterEach(() => cleanup(projectDir));

  it("returns KernelError{code: STATE_BUSY} when another connection holds the writer lock", async () => {
    // Prime the cache + migrations.
    openDb(projectDir);
    await seedBaseline(projectDir);

    const dbPath = join(projectDir, ".claude", "state.db");
    const blocker = new DatabaseSync(dbPath);
    blocker.exec("PRAGMA busy_timeout = 250");
    blocker.exec("BEGIN IMMEDIATE");

    try {
      await assert.rejects(
        withStateTransaction(
          projectDir,
          captureNow(),
          async () => { /* never reached — BEGIN IMMEDIATE blocks */ },
          { busyTimeoutMs: 250 },
        ),
        (err: unknown) => {
          assert.ok(err instanceof KernelError, `expected KernelError, got ${err}`);
          assert.equal((err as KernelError).code, "STATE_BUSY");
          return true;
        },
      );
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
  });
});
