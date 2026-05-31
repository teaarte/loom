import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildVocabularies,
  captureNow,
  closeDb,
  loadState,
  openDb,
  reconcileExtensions,
  withStateTransaction,
  type Agent,
  type Bundle,
  type DiscoveredManifest,
  type GateRole,
  type LLMProvider,
  type Policy,
  type PolicyName,
  type Registry,
  type Stage,
} from "@loomfsm/kernel";

import { createBackupTool, createRestoreTool, createRunTaskTool } from "../src/index.js";

const FIXED_NOW = "2026-05-28T10:00:00.000Z";

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

function buildRegistry(): Registry {
  const stages: Record<string, Stage> = {
    "spawn-1": { kind: "spawn", name: "spawn-1", phase: "work", agent: "impl-1" },
  };
  const agents: Agent[] = [
    { name: "impl-1", template_path: "templates/impl-1.md", output_kind: "nonreview" },
  ];
  const bundle: Bundle = {
    name: "code-fixture",
    version: "1.0.0",
    description: "backup test fixture bundle",
    phases: ["work"],
    default_flow: "standard",
    default_gate_policies: {} as Record<GateRole, PolicyName>,
    gate_roles: {},
    agents,
    stages,
    flows: { standard: ["spawn-1"] },
    hooks: [],
    invariants: [],
  };
  const provider: LLMProvider = {
    name: "stub",
    capabilities: { execution: "shuttle", idempotent_spawn: true, reports_usage: false },
    async spawn() {
      throw new Error("stub provider spawn must not be called");
    },
  };
  const policyFactories = new Map<PolicyName, () => Policy>();
  policyFactories.set("human", () => () => ({ type: "human-required", reason: "test" }));
  return {
    bundle,
    agents: new Map(agents.map((a) => [a.name, a])),
    stages: new Map(Object.entries(stages)),
    flows: new Map([["standard", ["spawn-1"]]]),
    hooks: [],
    invariants: [],
    mcp_clients: new Map(),
    providers: {
      resolve: () => provider,
      all: [provider],
      health_check_all: Promise.resolve([{ name: provider.name, healthy: true }]),
    },
    policyFactories,
    vocabularies: buildVocabularies(bundle),
  };
}

function allowlistFor(dir: string): string {
  const path = join(dir, "projects.allow");
  writeFileSync(path, `${realpathSync(dir)}\n`, "utf8");
  return path;
}

// Source project: migrated + a seeded task.
async function seededSource(): Promise<{ dir: string; allowlistPath: string; task_id: string; driver_state_id: string }> {
  const dir = mkdtempSync(join(tmpdir(), "loom-backup-src-"));
  openDb(dir);
  await reconcileExtensions({ manifests: [bundleManifest("code-fixture")], project_dir: dir, now: FIXED_NOW as never });
  const allowlistPath = allowlistFor(dir);
  const run = createRunTaskTool({ resolveRegistry: () => buildRegistry(), allowlistPath });
  const res = await run({ project_dir: dir, task: "back me up", client_idempotency_uuid: "uuid-b1" });
  if (res.response.status !== "spawn-agent") throw new Error("expected spawn-agent");
  return { dir, allowlistPath, task_id: res.task_id as string, driver_state_id: res.driver_state_id as string };
}

// Target project: migrated, empty (no bundle reconciled — the dump
// carries the installed_extensions row).
function freshTarget(): { dir: string; allowlistPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "loom-backup-tgt-"));
  openDb(dir);
  const allowlistPath = allowlistFor(dir);
  return { dir, allowlistPath };
}

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) {
    try {
      closeDb(dir);
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("pipeline_backup / pipeline_restore", () => {
  it("backup writes a non-empty .sql file and reports bytes_written", async () => {
    const src = await seededSource();
    try {
      const backup = createBackupTool({ allowlistPath: src.allowlistPath });
      const res = await backup({ project_dir: src.dir, to: "state.sql" });
      assert.equal(res.error, undefined);
      assert.ok((res.bytes_written ?? 0) > 0);
      assert.ok(res.backup_path !== null && existsSync(res.backup_path));
      assert.ok(readFileSync(res.backup_path as string, "utf8").includes("INSERT INTO pipeline_state"));
    } finally {
      cleanup(src.dir);
    }
  });

  it("restore(sql, confirm:true) reproduces the state in a fresh project", async () => {
    const src = await seededSource();
    const tgt = freshTarget();
    try {
      const backup = createBackupTool({ allowlistPath: src.allowlistPath });
      const dumped = await backup({ project_dir: src.dir, to: "state.sql" });
      const dumpPath = dumped.backup_path as string;

      const restore = createRestoreTool({ allowlistPath: tgt.allowlistPath });
      const res = await restore({ project_dir: tgt.dir, from: dumpPath, format: "sql", confirm: true });
      assert.equal(res.error, undefined);
      assert.equal(res.restored, true);

      const state = await withStateTransaction(tgt.dir, captureNow(), loadState);
      assert.equal(state.task_id, src.task_id);
      assert.equal(state.driver_state_id, src.driver_state_id);
      assert.equal(state.task, "back me up");
      assert.equal(state.status, "in_progress");
    } finally {
      cleanup(src.dir, tgt.dir);
    }
  });

  it("restore without confirm is refused with RESTORE_CONFIRM_REQUIRED", async () => {
    const src = await seededSource();
    const tgt = freshTarget();
    try {
      const backup = createBackupTool({ allowlistPath: src.allowlistPath });
      const dumped = await backup({ project_dir: src.dir, to: "state.sql" });
      const restore = createRestoreTool({ allowlistPath: tgt.allowlistPath });
      const res = await restore({ project_dir: tgt.dir, from: dumped.backup_path as string, format: "sql" });
      assert.equal(res.restored, false);
      assert.equal(res.error?.code, "RESTORE_CONFIRM_REQUIRED");
    } finally {
      cleanup(src.dir, tgt.dir);
    }
  });

  it("restore of a dump containing a refused statement surfaces RESTORE_REJECTED", async () => {
    const tgt = freshTarget();
    try {
      const evil = join(tgt.dir, "evil.sql");
      writeFileSync(evil, "DROP TABLE pipeline_state;\n", "utf8");
      const restore = createRestoreTool({ allowlistPath: tgt.allowlistPath });
      const res = await restore({ project_dir: tgt.dir, from: evil, format: "sql", confirm: true });
      assert.equal(res.restored, false);
      assert.equal(res.error?.code, "RESTORE_REJECTED");
    } finally {
      cleanup(tgt.dir);
    }
  });

  it("restore(binary, confirm:true) swaps the state.db and reproduces the state", async () => {
    const src = await seededSource();
    const tgt = freshTarget();
    const bkDir = mkdtempSync(join(tmpdir(), "loom-backup-bin-"));
    try {
      // Flush the WAL into the main db file (checkpoint on close), then
      // grab the binary state.db as the backup artifact.
      closeDb(src.dir);
      const binPath = join(bkDir, "state.db");
      copyFileSync(join(src.dir, ".claude", "state.db"), binPath);

      const restore = createRestoreTool({ allowlistPath: tgt.allowlistPath });
      const res = await restore({ project_dir: tgt.dir, from: binPath, format: "binary", confirm: true });
      assert.equal(res.error, undefined);
      assert.equal(res.restored, true);

      const state = await withStateTransaction(tgt.dir, captureNow(), loadState);
      assert.equal(state.task_id, src.task_id);
      assert.equal(state.driver_state_id, src.driver_state_id);
      assert.equal(state.task, "back me up");
    } finally {
      rmSync(bkDir, { recursive: true, force: true });
      cleanup(src.dir, tgt.dir);
    }
  });

  it("restore(binary) without confirm is refused with RESTORE_CONFIRM_REQUIRED", async () => {
    const tgt = freshTarget();
    try {
      const restore = createRestoreTool({ allowlistPath: tgt.allowlistPath });
      const res = await restore({ project_dir: tgt.dir, from: "whatever.db", format: "binary" });
      assert.equal(res.restored, false);
      assert.equal(res.error?.code, "RESTORE_CONFIRM_REQUIRED");
    } finally {
      cleanup(tgt.dir);
    }
  });

  it("a backup destination escaping project_dir is refused with BACKUP_PATH_REJECTED", async () => {
    const src = await seededSource();
    try {
      const backup = createBackupTool({ allowlistPath: src.allowlistPath });
      const res = await backup({ project_dir: src.dir, to: "../escape.sql" });
      assert.equal(res.bytes_written, null);
      assert.equal(res.error?.code, "BACKUP_PATH_REJECTED");
    } finally {
      cleanup(src.dir);
    }
  });
});
