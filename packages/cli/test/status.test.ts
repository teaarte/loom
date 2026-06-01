// `loom status` against a REAL migrated state DB (seeded through the
// kernel, not a hand-rolled schema). Age is computed host-side, so the
// command takes an injectable `nowMs` and the stalled/fresh cases pin a
// deterministic clock rather than racing the wall clock.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  closeDb,
  initializeTask,
  openDb,
  reconcileExtensions,
  withStateTransaction,
  type DiscoveredManifest,
  type NowToken,
} from "@loomfsm/kernel";

import { run } from "../src/cli.js";
import { status } from "../src/commands/status.js";
import type { CliEnv } from "../src/lib/env.js";

const NOW = "2026-05-31T12:00:00.000Z" as NowToken;
const NOW_MS = Date.parse(NOW);

function bundleManifest(name: string): DiscoveredManifest {
  return {
    path: `/fixture/bundle/${name}`,
    raw: {
      manifest_version: "1.0",
      name,
      display_name: name,
      description: "fixture bundle",
      version: "1.0.0",
      kind: "bundle",
      publisher: "@loom",
      capabilities: [],
      requires: { kernel_api: "^3.0.0" },
    },
  };
}

const dirs: string[] = [];

function makeEnv(cwd: string): { env: CliEnv; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const env: CliEnv = {
    home: "/tmp/nonexistent-home",
    cwd,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { env, out, err };
}

// Seed an in-progress task; `pendingAgent` adds a fresh pending row (its
// started_at = NOW keeps the zombie-pending invariant clean on commit —
// staleness is exercised by advancing the injected clock, not by writing a
// stale fixture). `pendingAnswer` parks the task at a gate.
async function seed(opts?: {
  pendingAgent?: boolean;
  pendingAnswer?: string;
  terminal?: "completed" | "abandoned";
}): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "loom-cli-status-"));
  dirs.push(dir);
  openDb(dir);
  await reconcileExtensions({ manifests: [bundleManifest("code-fixture")], project_dir: dir, now: NOW });
  await withStateTransaction(dir, NOW, (tx) =>
    initializeTask(tx, {
      project_dir: dir,
      task: "seeded task",
      client_idempotency_uuid: "uuid-seed",
      phases: ["work"],
    }),
  );
  if (opts?.pendingAgent === true) {
    await withStateTransaction(dir, NOW, (tx) =>
      tx.exec(
        "INSERT INTO pending_agents (agent_run_id, agent, phase, started_at) VALUES ('ar-0', 'impl-1', 'work', ?)",
        [NOW],
      ),
    );
  }
  if (opts?.pendingAnswer !== undefined) {
    await withStateTransaction(dir, NOW, (tx) =>
      tx.exec("UPDATE driver_state SET pending_user_answer = ? WHERE id = 1", [opts.pendingAnswer]),
    );
  }
  if (opts?.terminal !== undefined) {
    const verdict = opts.terminal === "completed" ? "accepted" : null;
    // A completed task needs every phase terminal for the invariant; sweep
    // the seeded phase to skipped alongside the status flip.
    await withStateTransaction(dir, NOW, (tx) =>
      tx.exec(
        "UPDATE phases SET status = 'skipped', skipped_reason = 'test', updated_at = ? WHERE status NOT IN ('completed','skipped')",
        [NOW],
      ),
    );
    await withStateTransaction(dir, NOW, (tx) =>
      tx.exec("UPDATE pipeline_state SET status = ?, verdict = ?, ended_at = ? WHERE id = 1", [
        opts.terminal,
        verdict,
        NOW,
      ]),
    );
  }
  closeDb(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      closeDb(d);
    } catch {
      /* ignore */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

describe("loom status", () => {
  it("reports no active task for an empty directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-cli-status-empty-"));
    dirs.push(dir);
    const { env, out } = makeEnv(dir);
    const code = await status([], env, NOW_MS);
    assert.equal(code, 0);
    assert.match(out.join("\n"), /no active task/);
  });

  it("shows an in-progress pending agent without a stalled verdict when fresh", async () => {
    const dir = await seed({ pendingAgent: true });
    const { env, out } = makeEnv(dir);
    // Five minutes after start — well under the zombie window.
    const code = await status([], env, NOW_MS + 5 * 60_000);
    assert.equal(code, 0);
    const text = out.join("\n");
    assert.match(text, /status:\s+in_progress/);
    assert.match(text, /pending:\s+1 agent/);
    assert.match(text, /impl-1 \(work\)/);
    assert.doesNotMatch(text, /stalled/);
  });

  it("flags a stalled verdict once a pending agent passes the zombie window", async () => {
    const dir = await seed({ pendingAgent: true });
    const { env, out } = makeEnv(dir);
    // 60 minutes after start — past the 50-minute zombie window.
    const code = await status([], env, NOW_MS + 60 * 60_000);
    assert.equal(code, 0);
    const text = out.join("\n");
    assert.match(text, /stalled ~60 min/);
    assert.match(text, /\/resume/);
  });

  it("reports the gate a parked task awaits", async () => {
    const dir = await seed({ pendingAnswer: '{"gate":"plan","message":"approve?","gate_event_id":"ge-1"}' });
    const { env, out } = makeEnv(dir);
    const code = await status([], env, NOW_MS);
    assert.equal(code, 0);
    const text = out.join("\n");
    assert.match(text, /awaiting your answer at gate 'plan'/);
    assert.doesNotMatch(text, /stalled/);
  });

  it("reports a finished task", async () => {
    const dir = await seed({ terminal: "completed" });
    const { env, out } = makeEnv(dir);
    const code = await status([], env, NOW_MS);
    assert.equal(code, 0);
    const text = out.join("\n");
    assert.match(text, /status:\s+completed \(verdict accepted\)/);
    assert.match(text, /this task is finished/);
  });

  it("routes through the dispatcher (no active task path)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-cli-status-disp-"));
    dirs.push(dir);
    const { env, out } = makeEnv(dir);
    const code = await run(["status"], env);
    assert.equal(code, 0);
    assert.match(out.join("\n"), /no active task/);
  });
});
