// `loom reset` / `loom history` against a REAL migrated state DB (seeded
// through the kernel, not a hand-rolled schema). The dispatcher returns a
// Promise for `reset` (it opens the store), so these await `run`.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  closeDb,
  initializeTask,
  openDb,
  withStateTransaction,
  type NowToken,
} from "@loomfsm/kernel";
import { reconcileExtensions, type DiscoveredManifest } from "@loomfsm/loader";

import { run } from "../src/cli.js";
import type { CliEnv } from "../src/lib/env.js";

const NOW = "2026-05-31T12:00:00.000Z" as NowToken;

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

async function seedTask(opts?: { terminal?: boolean }): Promise<{ dir: string; taskId: string }> {
  const dir = mkdtempSync(join(tmpdir(), "loom-cli-reset-"));
  dirs.push(dir);
  openDb(dir);
  await reconcileExtensions({ manifests: [bundleManifest("code-fixture")], project_dir: dir, now: NOW });
  const ids = await withStateTransaction(dir, NOW, (tx) =>
    initializeTask(tx, { project_dir: dir, task: "seeded task", client_idempotency_uuid: "uuid-seed", phases: ["work"] }),
  );
  if (opts?.terminal === true) {
    // Abandoned is a terminal status with a null verdict, so it needs no
    // phase sweep to stay invariant-clean.
    await withStateTransaction(dir, NOW, (tx) =>
      tx.exec("UPDATE pipeline_state SET status = 'abandoned', ended_at = ? WHERE id = 1", [NOW]),
    );
  }
  return { dir, taskId: ids.task_id };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      closeDb(dir);
    } catch {
      /* may already be closed by a reset */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("loom reset", () => {
  it("archives a finished task and frees the slot", async () => {
    const { dir, taskId } = await seedTask({ terminal: true });
    const { env, out } = makeEnv(dir);

    const code = await run(["reset"], env);
    assert.equal(code, 0);
    assert.ok(out.some((l) => l.includes("archived") && l.includes(taskId)), out.join("\n"));
    assert.equal(existsSync(join(dir, ".loom", "state.db")), false);
    assert.equal(existsSync(join(dir, ".loom", "history", `${taskId}.db`)), true);
  });

  it("refuses an in-progress task without --force, leaving the store intact", async () => {
    const { dir } = await seedTask();
    const { env, err } = makeEnv(dir);

    const code = await run(["reset"], env);
    assert.equal(code, 1);
    assert.ok(err.some((l) => /force/.test(l)), err.join("\n"));
    assert.equal(existsSync(join(dir, ".loom", "state.db")), true);
  });

  it("archives an in-progress task with --force", async () => {
    const { dir } = await seedTask();
    const { env } = makeEnv(dir);

    const code = await run(["reset", "--force"], env);
    assert.equal(code, 0);
    assert.equal(existsSync(join(dir, ".loom", "state.db")), false);
  });

  it("reports nothing to reset for a project with no state DB", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-cli-reset-empty-"));
    dirs.push(dir);
    const { env, out } = makeEnv(dir);

    const code = await run(["reset"], env);
    assert.equal(code, 0);
    assert.ok(out.some((l) => /nothing to reset/.test(l)));
  });

  it("--dry-run reports the intent without touching the store", async () => {
    const { dir, taskId } = await seedTask({ terminal: true });
    const { env, out } = makeEnv(dir);

    const code = await run(["reset", "--dry-run"], env);
    assert.equal(code, 0);
    assert.ok(out.some((l) => l.startsWith("[dry-run]") && l.includes(taskId)), out.join("\n"));
    // The store is untouched by a dry run.
    assert.equal(existsSync(join(dir, ".loom", "state.db")), true);
  });

  it("rejects an unknown flag", async () => {
    const { dir } = await seedTask({ terminal: true });
    const { env, err } = makeEnv(dir);
    const code = await run(["reset", "--frobnicate"], env);
    assert.equal(code, 1);
    assert.ok(err.some((l) => /unknown flag/.test(l)));
  });
});

describe("loom history", () => {
  it("lists the archived tasks for a project", async () => {
    const { dir, taskId } = await seedTask({ terminal: true });

    // Archive it first so the index exists.
    await run(["reset"], makeEnv(dir).env);

    const { env, out } = makeEnv(dir);
    const code = await run(["history"], env);
    assert.equal(code, 0);
    assert.ok(out.some((l) => l.includes(taskId) && l.includes("abandoned")), out.join("\n"));
  });

  it("reports an empty history when nothing has been archived", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-cli-hist-empty-"));
    dirs.push(dir);
    const { env, out } = makeEnv(dir);
    const code = await run(["history"], env);
    assert.equal(code, 0);
    assert.ok(out.some((l) => /no archived tasks/.test(l)));
  });
});
