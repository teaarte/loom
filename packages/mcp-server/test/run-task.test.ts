import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildVocabularies,
  captureNow,
  closeDb,
  DRIVER_STATE_ID_PATTERN,
  loadState,
  openDb,
  resolvePreset,
  TASK_ID_PATTERN,
  withStateTransaction,
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

import { createRunTaskTool } from "../src/index.js";

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

function stubProvider(): LLMProvider {
  return {
    name: "stub",
    capabilities: { execution: "shuttle", idempotent_spawn: true, reports_usage: false },
    async spawn() {
      throw new Error("stub provider spawn must not be called from the transport test");
    },
  };
}

// A registry with a single "standard" flow of one spawn stage — runFSM
// resolves to a shuttle directive on the first tick.
function buildRegistry(): Registry {
  const stages: Record<string, Stage> = {
    "spawn-1": { kind: "spawn", name: "spawn-1", phase: "work", agent: "impl" },
  };
  const agent: Agent = {
    name: "impl",
    template_path: "templates/impl.md",
    output_kind: "nonreview",
  };
  const bundle: Bundle = {
    name: "code-fixture",
    version: "1.0.0",
    description: "transport test fixture bundle",
    phases: ["work"],
    default_flow: "standard",
    default_gate_policies: {} as Record<GateRole, PolicyName>,
    gate_roles: {},
    agents: [agent],
    stages,
    flows: { standard: ["spawn-1"] },
    hooks: [],
    invariants: [],
  };
  const provider = stubProvider();
  const policyFactories = new Map<PolicyName, () => Policy>();
  policyFactories.set("human", () => () => ({ type: "human-required", reason: "test" }));
  return {
    bundle,
    agents: new Map([[agent.name, agent]]),
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

interface Harness {
  dir: string;
  allowlistPath: string;
  registry: Registry;
}

async function freshHarness(opts?: { permit?: boolean }): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "loom-run-task-"));
  openDb(dir);
  await reconcileExtensions({
    manifests: [bundleManifest("code-fixture")],
    project_dir: dir,
    now: FIXED_NOW as never,
  });
  const allowlistPath = join(dir, "projects.allow");
  // Permit by default; an empty allowlist exercises the refusal path.
  writeFileSync(allowlistPath, opts?.permit === false ? "" : `${realpathSync(dir)}\n`, "utf8");
  return { dir, allowlistPath, registry: buildRegistry() };
}

function cleanup(dir: string): void {
  try {
    closeDb(dir);
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
}

function makeTool(h: Harness) {
  return createRunTaskTool({
    // Mirror production's assembleRegistry: re-reconcile the bundle manifest on
    // every call so a slot archived since the last create (the rotation drops
    // installed-extensions rows with the store) is restored before the next
    // task's create reads them. Idempotent.
    resolveRegistry: async () => {
      await reconcileExtensions({
        manifests: [bundleManifest("code-fixture")],
        project_dir: h.dir,
        now: FIXED_NOW as never,
      });
      return h.registry;
    },
    allowlistPath: h.allowlistPath,
  });
}

describe("pipeline_run_task", () => {
  it("happy path returns a spawn-agent envelope with locked-format ids", async () => {
    const h = await freshHarness();
    try {
      const run = makeTool(h);
      const res = await run({
        project_dir: h.dir,
        task: "implement the feature",
        client_idempotency_uuid: "uuid-1",
        client_identifier_unverified: "claude-code",
      });

      assert.equal(res.response.status, "spawn-agent");
      assert.ok(res.task_id !== undefined && TASK_ID_PATTERN.test(res.task_id));
      assert.ok(
        res.driver_state_id !== undefined && DRIVER_STATE_ID_PATTERN.test(res.driver_state_id),
      );
      if (res.response.status === "spawn-agent") {
        assert.equal(res.response.spawn_request.runner_hint, "mcp-server");
        assert.equal(res.response.agent, "impl");
      }

      // The audit row co-commits with the create tx and carries the
      // (unverified) caller string under the forensic field.
      const audit = await withStateTransaction(h.dir, captureNow(), (tx) =>
        tx.queryRow<{ payload: string; task_id: string; driver_state_id: string }>(
          "SELECT payload, task_id, driver_state_id FROM audit WHERE type = 'pipeline_run_task'",
        ),
      );
      assert.ok(audit !== null, "expected a pipeline_run_task audit row");
      assert.equal(audit?.task_id, res.task_id);
      assert.equal(audit?.driver_state_id, res.driver_state_id);
      assert.equal(
        (JSON.parse(audit?.payload ?? "{}") as { client_identifier_unverified?: string })
          .client_identifier_unverified,
        "claude-code",
      );

      // The preset-resolved gate_policies map landed on the row (no
      // preset here → empty map, exercised in the parse test below).
      const state = await withStateTransaction(h.dir, captureNow(), (tx) => loadState(tx));
      assert.deepEqual(state.gate_policies, {});
    } finally {
      cleanup(h.dir);
    }
  });

  it("missing client_idempotency_uuid returns the documented error envelope", async () => {
    const h = await freshHarness();
    try {
      const run = makeTool(h);
      const res = await run({
        project_dir: h.dir,
        task: "no uuid here",
        client_idempotency_uuid: "",
      });
      assert.equal(res.response.status, "error");
      if (res.response.status === "error") {
        assert.equal(res.response.code, "TASK_IDEMPOTENCY_REQUIRED");
      }
      assert.equal(res.task_id, undefined);
    } finally {
      cleanup(h.dir);
    }
  });

  it("replay with the same UUID returns the identical cached envelope", async () => {
    const h = await freshHarness();
    try {
      const run = makeTool(h);
      const first = await run({
        project_dir: h.dir,
        task: "implement the feature",
        client_idempotency_uuid: "uuid-replay",
      });
      const second = await run({
        project_dir: h.dir,
        task: "implement the feature",
        client_idempotency_uuid: "uuid-replay",
      });
      assert.equal(second.task_id, first.task_id);
      assert.equal(second.driver_state_id, first.driver_state_id);
      assert.deepEqual(second.response, first.response);
    } finally {
      cleanup(h.dir);
    }
  });

  it("a project_dir outside the allowlist is refused", async () => {
    const h = await freshHarness({ permit: false });
    try {
      const run = makeTool(h);
      const res = await run({
        project_dir: h.dir,
        task: "blocked task",
        client_idempotency_uuid: "uuid-blocked",
      });
      assert.equal(res.response.status, "error");
      if (res.response.status === "error") {
        assert.equal(res.response.code, "PROJECT_DIR_NOT_ALLOWED");
      }
    } finally {
      cleanup(h.dir);
    }
  });

  it("parses a leading flag when no policy_preset is supplied; explicit preset bypasses", async () => {
    const h = await freshHarness();
    try {
      const run = makeTool(h);
      await run({
        project_dir: h.dir,
        task: "--auto build the thing",
        client_idempotency_uuid: "uuid-parsed",
      });
      const parsed = await withStateTransaction(h.dir, captureNow(), (tx) => loadState(tx));
      assert.equal(parsed.task, "build the thing"); // flag stripped by the parser
      // --auto maps to the full-autonomous preset, which must resolve
      // into the stored gate_policies map.
      assert.deepEqual(parsed.gate_policies, resolvePreset("full-autonomous"));
    } finally {
      cleanup(h.dir);
    }

    const h2 = await freshHarness();
    try {
      const run = makeTool(h2);
      await run({
        project_dir: h2.dir,
        task: "--auto keep me verbatim",
        client_idempotency_uuid: "uuid-explicit",
        policy_preset: "full-supervised",
      });
      const explicit = await withStateTransaction(h2.dir, captureNow(), (tx) => loadState(tx));
      assert.equal(explicit.task, "--auto keep me verbatim"); // parser skipped
      // The explicit preset (not the leading flag) resolved the map.
      assert.deepEqual(explicit.gate_policies, resolvePreset("full-supervised"));
    } finally {
      cleanup(h2.dir);
    }
  });
});

describe("pipeline_run_task — occupied-slot resolution (on_active_task)", () => {
  it("an IN-PROGRESS incumbent → a GUIDED refusal with resume + archive options (default)", async () => {
    const h = await freshHarness();
    try {
      const run = makeTool(h);
      const first = await run({ project_dir: h.dir, task: "first task", client_idempotency_uuid: "occ-1" });
      assert.equal(first.response.status, "spawn-agent"); // leaves the slot in_progress

      // A new task under a fresh uuid → not a silent clobber: a guided refusal.
      const second = await run({ project_dir: h.dir, task: "second task", client_idempotency_uuid: "occ-2" });
      assert.equal(second.response.status, "error");
      if (second.response.status === "error") {
        assert.equal(second.response.code, "PROJECT_TASK_ACTIVE");
        const choices = second.response.recovery_options.map((o) => o.choice);
        assert.deepEqual(choices, ["resume", "archive"], "the refusal must offer resume + archive");
      }
      // The incumbent is untouched (still the only live store, not archived).
      assert.ok(existsSync(join(h.dir, ".loom", "state.db")), "the in-progress store is intact");
      assert.ok(!existsSync(join(h.dir, ".loom", "history")), "nothing was archived on a refuse");
    } finally {
      cleanup(h.dir);
    }
  });

  it("on_active_task:'archive' force-archives the incumbent and starts the new task", async () => {
    const h = await freshHarness();
    try {
      const run = makeTool(h);
      const first = await run({ project_dir: h.dir, task: "throwaway", client_idempotency_uuid: "occ-3" });
      assert.equal(first.response.status, "spawn-agent");
      const firstTaskId = first.task_id;

      const replaced = await run({
        project_dir: h.dir,
        task: "the real task",
        client_idempotency_uuid: "occ-4",
        on_active_task: "archive",
      });
      // A fresh task started (a new spawn, a different task id).
      assert.equal(replaced.response.status, "spawn-agent");
      assert.notEqual(replaced.task_id, firstTaskId);

      // The incumbent was preserved in history (force-archive, not destroyed).
      const historyDir = join(h.dir, ".loom", "history");
      assert.ok(existsSync(historyDir), "the discarded incumbent is archived to history");
      assert.ok(readdirSync(historyDir).some((f) => f.endsWith(".db")), "a history .db snapshot exists");
    } finally {
      cleanup(h.dir);
    }
  });
});
