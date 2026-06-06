import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildVocabularies,
  closeDb,
  type Agent,
  type Bundle,
  type GateRole,
  type LLMProvider,
  type Policy,
  type PolicyName,
  type Registry,
  type Stage,
} from "@loomfsm/kernel";
import { reconcileExtensions, type DiscoveredManifest } from "@loomfsm/loader";

import { createArchiveResetTool, createRecoverTool, createRunTaskTool } from "../src/index.js";

const FIXED_NOW = "2026-05-31T10:00:00.000Z";

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
    description: "archive-reset test fixture bundle",
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

// Mirror the production resolver: reconcile the bundle manifest into the
// project store on every call (idempotent). Rotation deletes the store —
// including its installed-extensions rows — so the next task only finds its
// bundle because the resolver restores the manifest before the create tx.
function reconcilingResolver(): (projectDir: string) => Promise<Registry> {
  return async (projectDir: string) => {
    await reconcileExtensions({
      manifests: [bundleManifest("code-fixture")],
      project_dir: projectDir,
      now: FIXED_NOW as never,
    });
    return buildRegistry();
  };
}

async function makeProject(): Promise<{ dir: string; allowlistPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), "loom-reset-"));
  await reconcileExtensions({ manifests: [bundleManifest("code-fixture")], project_dir: dir, now: FIXED_NOW as never });
  return { dir, allowlistPath: allowlistFor(dir) };
}

// Run a task to its first directive (a spawn-agent), returning identity.
async function startTask(
  dir: string,
  allowlistPath: string,
  uuid: string,
  task: string,
): Promise<{ task_id: string; driver_state_id: string }> {
  const run = createRunTaskTool({ resolveRegistry: reconcilingResolver(), allowlistPath });
  const res = await run({ project_dir: dir, task, client_idempotency_uuid: uuid });
  assert.equal(res.response.status, "spawn-agent", `expected spawn-agent for ${uuid}`);
  return { task_id: res.task_id as string, driver_state_id: res.driver_state_id as string };
}

// Drive the task to a terminal status via the recovery surface (abandon).
async function abandon(dir: string, allowlistPath: string, driverStateId: string): Promise<void> {
  const recover = createRecoverTool({ allowlistPath });
  const res = await recover({ project_dir: dir, driver_state_id: driverStateId, choice: "abandon" });
  assert.equal(res.response.status, "complete");
}

function historyTaskIds(dir: string): string[] {
  const indexPath = join(dir, ".loom", "history", "index.jsonl");
  if (!existsSync(indexPath)) return [];
  return readFileSync(indexPath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => (JSON.parse(l) as { task_id: string }).task_id);
}

function cleanup(...dirs: string[]): void {
  for (const dir of dirs) {
    try {
      closeDb(dir);
    } catch {
      /* may already be closed by an archive */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("pipeline_archive_and_reset", () => {
  it("frees a terminal slot, and the next run_task then succeeds with the prior task in history", async () => {
    const { dir, allowlistPath } = await makeProject();
    try {
      const a = await startTask(dir, allowlistPath, "uuid-a", "task A");
      await abandon(dir, allowlistPath, a.driver_state_id);

      const reset = createArchiveResetTool({ allowlistPath });
      const res = await reset({ project_dir: dir });
      assert.equal(res.error, undefined);
      assert.equal(res.archived, true);
      assert.equal(res.task_id, a.task_id);
      assert.equal(existsSync(join(dir, ".loom", "state.db")), false);
      assert.deepEqual(historyTaskIds(dir), [a.task_id]);

      // A second task in the same project now starts clean.
      const b = await startTask(dir, allowlistPath, "uuid-b", "task B");
      assert.notEqual(b.task_id, a.task_id);
      assert.deepEqual(historyTaskIds(dir), [a.task_id]);
    } finally {
      cleanup(dir);
    }
  });

  it("refuses an in-progress slot without force, and archives it with force", async () => {
    const { dir, allowlistPath } = await makeProject();
    try {
      await startTask(dir, allowlistPath, "uuid-live", "live task");
      const reset = createArchiveResetTool({ allowlistPath });

      const refused = await reset({ project_dir: dir });
      assert.equal(refused.archived, false);
      assert.equal(refused.error?.code, "PROJECT_TASK_ACTIVE");
      assert.equal(existsSync(join(dir, ".loom", "state.db")), true);

      const forced = await reset({ project_dir: dir, force: true });
      assert.equal(forced.error, undefined);
      assert.equal(forced.archived, true);
      assert.equal(existsSync(join(dir, ".loom", "state.db")), false);
    } finally {
      cleanup(dir);
    }
  });

  it("refuses a project that is not on the allowlist", async () => {
    const { dir } = await makeProject();
    const otherAllow = join(dir, "other.allow");
    writeFileSync(otherAllow, "/some/other/path\n", "utf8");
    try {
      const reset = createArchiveResetTool({ allowlistPath: otherAllow });
      const res = await reset({ project_dir: dir });
      assert.equal(res.archived, false);
      assert.equal(res.error?.code, "PROJECT_DIR_NOT_ALLOWED");
    } finally {
      cleanup(dir);
    }
  });

  it("reports a no-op for a project with no active task", async () => {
    const { dir, allowlistPath } = await makeProject();
    try {
      const reset = createArchiveResetTool({ allowlistPath });
      const res = await reset({ project_dir: dir });
      assert.equal(res.error, undefined);
      assert.equal(res.archived, false);
    } finally {
      cleanup(dir);
    }
  });
});

describe("pipeline_run_task — sequential tasks in one project", () => {
  it("auto-rotates a terminal slot so the next task starts clean (no manual reset)", async () => {
    const { dir, allowlistPath } = await makeProject();
    try {
      const a = await startTask(dir, allowlistPath, "uuid-a1", "task A");
      await abandon(dir, allowlistPath, a.driver_state_id);

      // No explicit archive — run_task itself rotates the finished slot.
      const b = await startTask(dir, allowlistPath, "uuid-b1", "task B");
      assert.notEqual(b.task_id, a.task_id);
      assert.deepEqual(historyTaskIds(dir), [a.task_id]);
    } finally {
      cleanup(dir);
    }
  });

  it("returns a typed PROJECT_TASK_ACTIVE envelope when a live task occupies the slot", async () => {
    const { dir, allowlistPath } = await makeProject();
    try {
      await startTask(dir, allowlistPath, "uuid-live2", "live task");

      // A NEW task while the first is still in progress: a typed error
      // envelope, never a raw backend constraint error thrown out of the tool.
      const run = createRunTaskTool({ resolveRegistry: reconcilingResolver(), allowlistPath });
      const res = await run({ project_dir: dir, task: "second task", client_idempotency_uuid: "uuid-second" });
      assert.equal(res.response.status, "error");
      if (res.response.status === "error") {
        assert.equal(res.response.code, "PROJECT_TASK_ACTIVE");
      }
      // The live task is untouched.
      assert.equal(existsSync(join(dir, ".loom", "state.db")), true);
      assert.deepEqual(historyTaskIds(dir), []);
    } finally {
      cleanup(dir);
    }
  });

  it("never auto-rotates an in-progress slot", async () => {
    const { dir, allowlistPath } = await makeProject();
    try {
      await startTask(dir, allowlistPath, "uuid-live3", "live task");
      const run = createRunTaskTool({ resolveRegistry: reconcilingResolver(), allowlistPath });
      // The collision refusal proves the live slot was not silently rotated.
      const res = await run({ project_dir: dir, task: "next", client_idempotency_uuid: "uuid-next" });
      assert.equal(res.response.status, "error");
      if (res.response.status === "error") {
        assert.equal(res.response.code, "PROJECT_TASK_ACTIVE");
      }
      assert.deepEqual(historyTaskIds(dir), []);
    } finally {
      cleanup(dir);
    }
  });
});
