import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  STALL_THRESHOLD,
  clearBlockerStall,
  evaluateBlockerStall,
} from "../src/lib/blocker-stall.js";
import { _resetInvariantsForTest } from "../src/invariants.js";
import { captureNow, closeDb, withStateTransaction } from "../src/state.js";
import type { Transaction } from "../src/types/transaction.js";

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "loom-stall-"));
}

function cleanup(dir: string): void {
  try {
    closeDb(dir);
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
}

async function seed(dir: string): Promise<void> {
  const now = captureNow();
  await withStateTransaction(dir, now, async (tx) => {
    await tx.exec(
      "INSERT INTO pipeline_state (id, schema_version, project_dir, bundle, task, " +
        "task_id, driver_state_id, status, started_at, decisions) " +
        "VALUES (1, '3.0.0', ?, 'b', 'stall fixture', 't-stall', 'd-stall', 'in_progress', ?, '{}')",
      [dir, now],
    );
    await tx.exec(
      "INSERT INTO driver_state (id, flow_name, step_index, complete, scratch) " +
        "VALUES (1, 'f', 0, 0, '{}')",
    );
    await tx.exec("INSERT INTO pipeline_counters (id) VALUES (1)");
    await tx.exec(
      "INSERT INTO phases (name, status, updated_at) VALUES ('impl', 'in_progress', ?)",
      [now],
    );
  });
}

async function insertBlocker(
  dir: string,
  id: string,
  opts: { category: string; file: string | null; line: number | null; agent: string; origin: string },
): Promise<void> {
  const now = captureNow();
  await withStateTransaction(dir, now, async (tx) => {
    await tx.exec(
      "INSERT INTO findings (id, agent, iteration, phase, file, line_start, " +
        "severity, category, summary, status, origin, recorded_at) " +
        "VALUES (?, ?, 1, 'impl', ?, ?, 'blocking', ?, 'sum', 'open', ?, ?)",
      [id, opts.agent, opts.file, opts.line, opts.category, opts.origin, now],
    );
  });
}

async function deleteFinding(dir: string, id: string): Promise<void> {
  await withStateTransaction(dir, captureNow(), (tx) => tx.exec("DELETE FROM findings WHERE id = ?", [id]));
}

// One rework round: read scratch (as the gate reloads it from disk), evaluate.
async function round(dir: string): Promise<{ count: number; stalled: boolean }> {
  return withStateTransaction(dir, captureNow(), async (tx: Transaction) => {
    const row = await tx.queryRow<{ scratch: string }>(
      "SELECT scratch FROM driver_state WHERE id = 1",
    );
    const scratch = JSON.parse(row?.scratch ?? "{}") as Record<string, unknown>;
    const r = await evaluateBlockerStall(tx, scratch);
    return { count: r.count, stalled: r.stalled };
  });
}

describe("blocker stall breaker", () => {
  let dir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    dir = freshProject();
  });
  afterEach(() => cleanup(dir));

  it("an unchanged code-blocker set trips the breaker at STALL_THRESHOLD", async () => {
    await seed(dir);
    await insertBlocker(dir, "f1", { category: "correctness", file: "src/x.ts", line: 10, agent: "logic-reviewer", origin: "code" });

    const r1 = await round(dir);
    assert.equal(r1.count, 1);
    assert.equal(r1.stalled, false);

    const r2 = await round(dir);
    assert.equal(r2.count, STALL_THRESHOLD);
    assert.equal(r2.stalled, true, "the same blocker set recurring trips the breaker");
  });

  it("a changing blocker set resets the counter (progress is being made)", async () => {
    await seed(dir);
    await insertBlocker(dir, "f1", { category: "correctness", file: "src/x.ts", line: 10, agent: "logic-reviewer", origin: "code" });
    const r1 = await round(dir);
    assert.equal(r1.count, 1);

    // The blocker changed between rounds — different location → fresh count.
    await deleteFinding(dir, "f1");
    await insertBlocker(dir, "f2", { category: "correctness", file: "src/y.ts", line: 20, agent: "logic-reviewer", origin: "code" });
    const r2 = await round(dir);
    assert.equal(r2.count, 1, "a changed blocker set resets the counter");
    assert.equal(r2.stalled, false);
  });

  it("a harness-only blocker set never stalls (it routes to a human elsewhere)", async () => {
    await seed(dir);
    await insertBlocker(dir, "fh", { category: "unparseable-output", file: null, line: null, agent: "rev", origin: "harness" });
    const r1 = await round(dir);
    const r2 = await round(dir);
    assert.equal(r1.stalled, false);
    assert.equal(r2.stalled, false, "harness blockers are excluded from the code-blocker stall");
  });

  it("clearBlockerStall resets the counters", async () => {
    await seed(dir);
    await insertBlocker(dir, "f1", { category: "correctness", file: "src/x.ts", line: 10, agent: "logic-reviewer", origin: "code" });
    await round(dir);
    await round(dir); // now stalled

    await withStateTransaction(dir, captureNow(), async (tx) => {
      const row = await tx.queryRow<{ scratch: string }>("SELECT scratch FROM driver_state WHERE id = 1");
      const scratch = JSON.parse(row?.scratch ?? "{}") as Record<string, unknown>;
      await clearBlockerStall(tx, scratch);
    });

    // After a clear, the next round starts fresh at count 1.
    const r = await round(dir);
    assert.equal(r.count, 1);
    assert.equal(r.stalled, false);
  });
});
