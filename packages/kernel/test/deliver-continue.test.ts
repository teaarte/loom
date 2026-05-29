import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { deliverContinue } from "../src/lib/deliver-continue.js";
import { kernelDefaultVocabularies } from "../src/vocabularies.js";
import {
  KernelError,
  closeDb,
  loadState,
  openDb,
  withStateTransaction,
} from "../src/state.js";
import type { NowToken } from "../src/types/now.js";
import type { Transaction } from "../src/types/transaction.js";

const FIXED_NOW = "2026-05-28T10:00:00.000Z" as NowToken;
const DRIVER = "d-deliver";

interface PendingSeed {
  agent_run_id: string;
  agent: string;
  phase: string;
}

interface SeedOpts {
  step_index?: number;
  phases?: string[];
  pending?: PendingSeed[];
  pending_user_answer?: string | null;
}

async function seedTask(dir: string, opts: SeedOpts = {}): Promise<void> {
  const phases = opts.phases ?? ["work"];
  const pending = opts.pending ?? [];
  const stepIndex = opts.step_index ?? 0;
  const pua = opts.pending_user_answer ?? null;
  await withStateTransaction(dir, FIXED_NOW, async (tx: Transaction) => {
    await tx.exec(
      "INSERT INTO pipeline_state (id, schema_version, project_dir, bundle, task_id, task, " +
        "driver_state_id, status, verdict, started_at, gate_policies, decisions) " +
        "VALUES (1, '3.0.0', ?, 'code-fixture', 't-2026-05-28-seed', 'seeded task', ?, " +
        "'in_progress', NULL, ?, '{}', '{}')",
      [dir, DRIVER, FIXED_NOW],
    );
    await tx.exec(
      "INSERT INTO driver_state (id, flow_name, step_index, complete, pending_user_answer, scratch) " +
        "VALUES (1, 'standard', ?, 0, ?, '{}')",
      [stepIndex, pua],
    );
    await tx.exec("INSERT INTO pipeline_counters (id) VALUES (1)");
    for (const phase of phases) {
      await tx.exec(
        "INSERT INTO phases (name, status, skipped_reason, updated_at) VALUES (?, 'pending', NULL, ?)",
        [phase, FIXED_NOW],
      );
    }
    for (const p of pending) {
      await tx.exec(
        "INSERT INTO pending_agents (agent_run_id, agent, phase, model, started_at) " +
          "VALUES (?, ?, ?, NULL, ?)",
        [p.agent_run_id, p.agent, p.phase, FIXED_NOW],
      );
    }
  });
}

// Each test runs against its own fresh project dir, cleaned up in a
// `finally` — the same isolation shape the read-only tool tests use.
async function withFreshDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "loom-deliver-"));
  openDb(dir);
  try {
    await fn(dir);
  } finally {
    try {
      closeDb(dir);
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

// Read-after-write goes through a fresh tx so it observes the committed
// snapshot.
async function read<T>(dir: string, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return withStateTransaction(dir, FIXED_NOW, fn);
}

describe("deliverContinue", () => {
  it("agent-result persists, drains the pending row, bumps counters, advances", async () =>
    withFreshDir(async (dir) => {
      const arid = "ar-00000000-0000-0000-0000-000000000001";
      await seedTask(dir, {
        pending: [{ agent_run_id: arid, agent: "impl", phase: "work" }],
      });

      await withStateTransaction(dir, FIXED_NOW, (tx) =>
        deliverContinue(tx, {
          input: { type: "agent-result", agent_run_id: arid, agent_output: "done" },
          driver_state_id: DRIVER,
        }),
      );

      const state = await read(dir, (tx) => loadState(tx));
      assert.equal(state.agents_count, 1);
      assert.equal(state.pending_agents.length, 0);
      assert.equal(state.driver.step_index, 1);

      const records = await read(dir, (tx) =>
        tx.queryRow<{ c: number }>("SELECT COUNT(*) AS c FROM agent_records"),
      );
      assert.equal(Number(records?.c), 1);

      const ledger = await read(dir, (tx) =>
        tx.queryRow<{ key: string }>(
          "SELECT key FROM kernel_idempotency_ledger WHERE key = ?",
          [`agent-result:${arid}`],
        ),
      );
      assert.ok(ledger !== null);
    }));

  it("agent-result replay does not re-persist or double-bump counters", async () =>
    withFreshDir(async (dir) => {
      const arid = "ar-00000000-0000-0000-0000-000000000002";
      await seedTask(dir, {
        pending: [{ agent_run_id: arid, agent: "impl", phase: "work" }],
      });

      const deliver = () =>
        withStateTransaction(dir, FIXED_NOW, (tx) =>
          deliverContinue(tx, {
            input: { type: "agent-result", agent_run_id: arid, agent_output: "done" },
            driver_state_id: DRIVER,
          }),
        );
      await deliver();
      const afterFirst = await read(dir, (tx) => loadState(tx));
      await deliver(); // replay
      const afterReplay = await read(dir, (tx) => loadState(tx));

      // Replay is a pure no-op: no extra record, no counter bump, and —
      // the regression this guards — no second step advance.
      assert.equal(afterReplay.agents_count, 1);
      assert.equal(afterFirst.driver.step_index, 1);
      assert.equal(afterReplay.driver.step_index, 1);

      const records = await read(dir, (tx) =>
        tx.queryRow<{ c: number }>("SELECT COUNT(*) AS c FROM agent_records"),
      );
      assert.equal(Number(records?.c), 1);
    }));

  it("agents-results persists every result, drains all, writes one ledger row each", async () =>
    withFreshDir(async (dir) => {
      const a = "ar-00000000-0000-0000-0000-00000000000a";
      const b = "ar-00000000-0000-0000-0000-00000000000b";
      await seedTask(dir, {
        pending: [
          { agent_run_id: a, agent: "rev-a", phase: "work" },
          { agent_run_id: b, agent: "rev-b", phase: "work" },
        ],
      });

      await withStateTransaction(dir, FIXED_NOW, (tx) =>
        deliverContinue(tx, {
          input: {
            type: "agents-results",
            results: [
              { agent_run_id: a, agent_output: "a done" },
              { agent_run_id: b, agent_output: "b done" },
            ],
          },
          driver_state_id: DRIVER,
        }),
      );

      const state = await read(dir, (tx) => loadState(tx));
      assert.equal(state.agents_count, 2);
      assert.equal(state.pending_agents.length, 0);

      const ledgerKeys = (
        await read(dir, (tx) =>
          tx.queryAll<{ key: string }>(
            "SELECT key FROM kernel_idempotency_ledger WHERE key LIKE 'agent-result:%' ORDER BY key",
          ),
        )
      ).map((r) => r.key);
      assert.deepEqual(ledgerKeys, [`agent-result:${a}`, `agent-result:${b}`]);
    }));

  it("user-answer records the gate decision, clears the pending answer, advances", async () =>
    withFreshDir(async (dir) => {
      const pua = JSON.stringify({
        gate: "gate-plan",
        message: "Approve the plan?",
        gate_event_id: "gev-00000000-0000-0000-0000-000000000001",
      });
      await seedTask(dir, { step_index: 2, pending_user_answer: pua });

      await withStateTransaction(dir, FIXED_NOW, (tx) =>
        deliverContinue(tx, {
          input: {
            type: "user-answer",
            gate_event_id: "gev-00000000-0000-0000-0000-000000000001",
            decision: "accept",
            message: "looks good",
          },
          driver_state_id: DRIVER,
        }),
      );

      const gate = await read(dir, (tx) =>
        tx.queryRow<{ status: string; decided_by: string; feedback: string }>(
          "SELECT status, decided_by, feedback FROM gates WHERE name = 'gate-plan'",
        ),
      );
      assert.ok(gate !== null);
      assert.equal(gate?.status, "approved");
      assert.equal(gate?.decided_by, "human");
      assert.equal(gate?.feedback, "looks good");

      const state = await read(dir, (tx) => loadState(tx));
      assert.equal(state.driver.pending_user_answer, null);
      assert.equal(state.driver.step_index, 3);

      const ledger = await read(dir, (tx) =>
        tx.queryRow<{ key: string }>(
          "SELECT key FROM kernel_idempotency_ledger WHERE key = ?",
          ["user-answer:gev-00000000-0000-0000-0000-000000000001"],
        ),
      );
      assert.ok(ledger !== null);
    }));

  it("agent-result with an undeclared output_kind is refused VOCAB_UNKNOWN and rolls back", async () =>
    withFreshDir(async (dir) => {
      const arid = "ar-00000000-0000-0000-0000-0000000000c1";
      await seedTask(dir, {
        pending: [{ agent_run_id: arid, agent: "weird-agent", phase: "work" }],
      });

      // This is the PRODUCTION seam: deliverContinue resolves the
      // agent's output_kind (here an undeclared one, as a bundle agent
      // could declare) and threads the registry vocabularies into the
      // persistor. The undeclared kind must be refused before any row
      // lands. Reverting the deliver→persist vocab threading makes this
      // pass (the gap this test closes).
      await assert.rejects(
        withStateTransaction(dir, FIXED_NOW, (tx) =>
          deliverContinue(tx, {
            input: { type: "agent-result", agent_run_id: arid, agent_output: "done" },
            driver_state_id: DRIVER,
            resolveOutputKind: () => "made-up-kind",
            vocabularies: kernelDefaultVocabularies(),
          }),
        ),
        (err: unknown) => err instanceof KernelError && err.code === "VOCAB_UNKNOWN",
      );

      // Rolled back: no agent_records row, pending still stands, counters
      // untouched, no ledger row.
      const state = await read(dir, (tx) => loadState(tx));
      assert.equal(state.agents_count, 0);
      assert.equal(state.pending_agents.length, 1);
      const recs = await read(dir, (tx) =>
        tx.queryRow<{ c: number }>("SELECT COUNT(*) AS c FROM agent_records"),
      );
      assert.equal(Number(recs?.c), 0);
      const ledger = await read(dir, (tx) =>
        tx.queryRow<{ key: string }>(
          "SELECT key FROM kernel_idempotency_ledger WHERE key = ?",
          [`agent-result:${arid}`],
        ),
      );
      assert.equal(ledger, null);
    }));

  it("user-answer with a stale gate_event_id is refused", async () =>
    withFreshDir(async (dir) => {
      // No gate is awaiting an answer — pending_user_answer is null.
      await seedTask(dir, { pending_user_answer: null });

      await assert.rejects(
        withStateTransaction(dir, FIXED_NOW, (tx) =>
          deliverContinue(tx, {
            input: {
              type: "user-answer",
              gate_event_id: "gev-00000000-0000-0000-0000-0000000000ff",
              decision: "accept",
            },
            driver_state_id: DRIVER,
          }),
        ),
        (err: unknown) => err instanceof KernelError && err.code === "GATE_EVENT_STALE",
      );
    }));
});
