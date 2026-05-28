// Drives the two advisory bash hooks through child_process with crafted
// Claude Code hook JSON on stdin, asserting the concrete deny/allow
// outcome (guard) and the non-blocking hint + graceful degrade (stop).
//
// The scripts are POSIX-sh-safe shell, not a packaged dependency; these
// tests exercise them exactly as Claude Code would invoke them. The stop
// tests seed a REAL migrated kernel state DB (via openDb) rather than a
// hand-rolled schema, so the hook's column names stay load-bearing — a
// kernel rename of status / owner_id / pending_user_answer / pending_agents
// breaks the test, not just production.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { captureNow, closeDb, openDb, withStateTransaction } from "@loom/kernel";

import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// dist/test/cc-adapter.test.js → ../../cc-adapter/<script>.sh
const adapterDir = join(here, "..", "..", "cc-adapter");
const GUARD = join(adapterDir, "pipeline-guard.sh");
const STOP = join(adapterDir, "pipeline-stop.sh");

function runHook(
  script: string,
  stdin: string,
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("bash", [script], { input: stdin, encoding: "utf8" });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function runHookJson(script: string, payload: unknown) {
  return runHook(script, JSON.stringify(payload));
}

function sqlite3Available(): boolean {
  return spawnSync("sqlite3", ["--version"], { encoding: "utf8" }).status === 0;
}

// Seed a real migrated state DB, then INSERT a canonical row set with the
// kernel's actual column names. closeDb checkpoints the WAL into the main
// file so the hook's separate sqlite3 process reads the committed rows.
interface SeedOpts {
  status: "in_progress" | "completed" | "abandoned";
  ownerId: string | null;
  pendingAgents: number;
  pendingAnswer: string | null;
}
async function seedStateDb(dir: string, opts: SeedOpts): Promise<void> {
  openDb(dir); // runs migrations → real pipeline_state / driver_state / pending_agents
  await withStateTransaction(dir, captureNow(), async (tx) => {
    await tx.exec(
      "INSERT INTO pipeline_state " +
        "(id, schema_version, project_dir, bundle, task, driver_state_id, owner_id, status, started_at) " +
        "VALUES (1, '3.0.0', ?, 'code-fixture', 'seeded task', 'd-seed', ?, ?, ?)",
      [dir, opts.ownerId, opts.status, "2026-05-29T00:00:00.000Z"],
    );
    await tx.exec(
      "INSERT INTO driver_state (id, flow_name, pending_user_answer) VALUES (1, 'standard', ?)",
      [opts.pendingAnswer],
    );
    for (let i = 0; i < opts.pendingAgents; i++) {
      await tx.exec(
        "INSERT INTO pending_agents (agent_run_id, agent, phase, started_at) VALUES (?, 'impl-1', 'work', ?)",
        [`ar-${i}`, "2026-05-29T00:00:00.000Z"],
      );
    }
  });
  closeDb(dir);
}

describe("pipeline-guard.sh (advisory PreToolUse hook)", () => {
  it("denies a direct rm of the state DB (non-zero + deny decision)", () => {
    const r = runHookJson(GUARD, {
      tool_name: "Bash",
      tool_input: { command: "rm -f /proj/.claude/state.db" },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /"permissionDecision":"deny"/);
  });

  it("denies an mv of the state DB", () => {
    const r = runHookJson(GUARD, {
      tool_name: "Bash",
      tool_input: { command: "mv ./.claude/state.db /tmp/x" },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /deny/);
  });

  it("denies an output-redirect onto the state DB", () => {
    const r = runHookJson(GUARD, {
      tool_name: "Bash",
      tool_input: { command: "echo corrupt > ./.claude/state.db" },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /deny/);
  });

  it("denies an in-place sed of the state DB", () => {
    const r = runHookJson(GUARD, {
      tool_name: "Bash",
      tool_input: { command: "sed -i 's/a/b/' some/.claude/state.db" },
    });
    assert.notEqual(r.status, 0);
  });

  it("passes an unrelated command through (exit 0)", () => {
    const r = runHookJson(GUARD, { tool_name: "Bash", tool_input: { command: "ls -la" } });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "");
  });

  it("passes a read of the state DB through (only mutations are denied)", () => {
    const r = runHookJson(GUARD, {
      tool_name: "Bash",
      tool_input: { command: "sqlite3 .claude/state.db .tables" },
    });
    assert.equal(r.status, 0);
  });

  it("degrades to pass-through on empty or malformed stdin (defensive parse)", () => {
    // No command extractable → safe default is allow, never a spurious deny.
    assert.equal(runHook(GUARD, "").status, 0);
    assert.equal(runHook(GUARD, "not json at all").status, 0);
    assert.equal(runHook(GUARD, "{}").status, 0);
  });
});

describe("pipeline-stop.sh (advisory Stop hook)", () => {
  it("degrades to a generic note when no state DB exists (non-blocking, exit 0)", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-stop-empty-"));
    try {
      const r = runHookJson(STOP, { cwd: dir, session_id: "sess-1" });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^pipeline: /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a real migrated DB and reports in-flight for a pending agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-stop-inflight-"));
    try {
      await seedStateDb(dir, {
        status: "in_progress",
        ownerId: "sess-1",
        pendingAgents: 1,
        pendingAnswer: null,
      });
      const r = runHookJson(STOP, { cwd: dir, session_id: "sess-1" });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^pipeline: /);
      // The tri-state read only runs when the sqlite3 CLI is on PATH.
      if (sqlite3Available()) assert.match(r.stdout, /in-flight/);
    } finally {
      try {
        closeDb(dir);
      } catch {
        /* already closed by the seed */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags gate-paused when a checkpoint awaits an answer", async () => {
    if (!sqlite3Available()) return; // tri-state read needs the sqlite3 CLI
    const dir = mkdtempSync(join(tmpdir(), "loom-stop-gate-"));
    try {
      await seedStateDb(dir, {
        status: "in_progress",
        ownerId: "sess-1",
        pendingAgents: 0,
        pendingAnswer: '{"awaiting":true}',
      });
      const r = runHookJson(STOP, { cwd: dir, session_id: "sess-1" });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /gate-paused/);
    } finally {
      try {
        closeDb(dir);
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports accept-pending and notes a cross-owner session", async () => {
    if (!sqlite3Available()) return;
    const dir = mkdtempSync(join(tmpdir(), "loom-stop-accept-"));
    try {
      await seedStateDb(dir, {
        status: "in_progress",
        ownerId: "alice",
        pendingAgents: 0,
        pendingAnswer: null,
      });
      const r = runHookJson(STOP, { cwd: dir, session_id: "bob" });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /accept-pending/);
      assert.match(r.stdout, /another session/);
    } finally {
      try {
        closeDb(dir);
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a finalized task and never blocks", async () => {
    if (!sqlite3Available()) return;
    const dir = mkdtempSync(join(tmpdir(), "loom-stop-final-"));
    try {
      await seedStateDb(dir, {
        status: "completed",
        ownerId: "sess-1",
        pendingAgents: 0,
        pendingAnswer: null,
      });
      const r = runHookJson(STOP, { cwd: dir, session_id: "sess-1" });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /finalized/);
    } finally {
      try {
        closeDb(dir);
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
