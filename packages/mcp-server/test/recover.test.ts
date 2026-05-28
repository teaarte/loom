import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildVocabularies,
  captureNow,
  closeDb,
  loadState,
  makeRecoveryId,
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
} from "@loom/kernel";

import { createRecoverTool, createRunTaskTool } from "../src/index.js";

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

function buildRegistry(): Registry {
  const stages: Record<string, Stage> = {
    "spawn-1": { kind: "spawn", name: "spawn-1", phase: "work", agent: "impl-1" },
    "spawn-2": { kind: "spawn", name: "spawn-2", phase: "work", agent: "impl-2" },
  };
  const agents: Agent[] = [
    { name: "impl-1", template_path: "templates/impl-1.md", output_kind: "nonreview" },
    { name: "impl-2", template_path: "templates/impl-2.md", output_kind: "nonreview" },
  ];
  const bundle: Bundle = {
    name: "code-fixture",
    version: "1.0.0",
    description: "transport test fixture bundle",
    phases: ["work"],
    default_flow: "standard",
    default_gate_policies: {} as Record<GateRole, PolicyName>,
    gate_roles: {},
    agents,
    stages,
    flows: { standard: ["spawn-1", "spawn-2"] },
    hooks: [],
    invariants: [],
  };
  const provider = stubProvider();
  const policyFactories = new Map<PolicyName, () => Policy>();
  policyFactories.set("human", () => () => ({ type: "human-required", reason: "test" }));
  return {
    bundle,
    agents: new Map(agents.map((a) => [a.name, a])),
    stages: new Map(Object.entries(stages)),
    flows: new Map([["standard", ["spawn-1", "spawn-2"]]]),
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

async function freshHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "loom-recover-mcp-"));
  openDb(dir);
  await reconcileExtensions({
    manifests: [bundleManifest("code-fixture")],
    project_dir: dir,
    now: FIXED_NOW as never,
  });
  const allowlistPath = join(dir, "projects.allow");
  writeFileSync(allowlistPath, `${realpathSync(dir)}\n`, "utf8");
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

function tools(h: Harness) {
  const deps = { resolveRegistry: () => h.registry, allowlistPath: h.allowlistPath };
  return { run: createRunTaskTool(deps), recover: createRecoverTool(deps) };
}

// Create the task and return its driver_state_id + the first spawn's
// agent_run_id (the pending agent the recovery acts on).
async function bootstrap(h: Harness, uuid: string, ownerId?: string) {
  const { run } = tools(h);
  const res = await run({
    project_dir: h.dir,
    task: "do work",
    client_idempotency_uuid: uuid,
    ...(ownerId !== undefined ? { owner_id: ownerId } : {}),
  });
  if (res.response.status !== "spawn-agent") throw new Error("expected spawn-agent");
  return { driver_state_id: res.driver_state_id as string, agent_run_id: res.response.agent_run_id };
}

describe("pipeline_recover", () => {
  it("abandon shapes a terminal envelope and carries a recovery_id", async () => {
    const h = await freshHarness();
    try {
      const { driver_state_id } = await bootstrap(h, "uuid-r1");
      const { recover } = tools(h);
      const res = await recover({ project_dir: h.dir, driver_state_id, choice: "abandon" });
      assert.equal(res.response.status, "complete");
      assert.match(res.recovery_id, /^rec-/);
      const state = await withStateTransaction(h.dir, captureNow(), loadState);
      assert.equal(state.status, "abandoned");
      assert.equal(state.verdict, null);
    } finally {
      cleanup(h.dir);
    }
  });

  it("force-close shapes a terminal envelope with verdict failed_force_closed", async () => {
    const h = await freshHarness();
    try {
      const { driver_state_id } = await bootstrap(h, "uuid-r2");
      const { recover } = tools(h);
      const res = await recover({ project_dir: h.dir, driver_state_id, choice: "force-close" });
      assert.equal(res.response.status, "complete");
      if (res.response.status === "complete") {
        assert.equal(res.response.verdict, "failed_force_closed");
      }
      const state = await withStateTransaction(h.dir, captureNow(), loadState);
      assert.equal(state.status, "completed");
      assert.equal(state.verdict, "failed_force_closed");
    } finally {
      cleanup(h.dir);
    }
  });

  it("cancel-pending advances the FSM to the next directive", async () => {
    const h = await freshHarness();
    try {
      const { driver_state_id } = await bootstrap(h, "uuid-r3");
      const { recover } = tools(h);
      const res = await recover({ project_dir: h.dir, driver_state_id, choice: "cancel-pending" });
      assert.equal(res.response.status, "spawn-agent");
      if (res.response.status === "spawn-agent") {
        assert.equal(res.response.agent, "impl-2");
      }
      assert.match(res.recovery_id, /^rec-/);
    } finally {
      cleanup(h.dir);
    }
  });

  it("retry-failed with an unknown id is refused as RECOVERY_STALE", async () => {
    const h = await freshHarness();
    try {
      const { driver_state_id } = await bootstrap(h, "uuid-r4");
      const { recover } = tools(h);
      const res = await recover({
        project_dir: h.dir,
        driver_state_id,
        choice: "retry-failed",
        agent_run_ids: ["ar-00000000-0000-0000-0000-0000000000ff"],
      });
      assert.equal(res.response.status, "error");
      if (res.response.status === "error") {
        assert.equal(res.response.code, "RECOVERY_STALE");
      }
      assert.match(res.recovery_id, /^rec-/);
    } finally {
      cleanup(h.dir);
    }
  });

  it("retry-failed with a real pending id commits the recovery and caches its envelope", async () => {
    const h = await freshHarness();
    try {
      const { driver_state_id, agent_run_id } = await bootstrap(h, "uuid-r5");
      const { recover } = tools(h);
      const res = await recover({
        project_dir: h.dir,
        driver_state_id,
        choice: "retry-failed",
        agent_run_ids: [agent_run_id],
      });
      assert.match(res.recovery_id, /^rec-/);
      // The recovery committed; the FSM re-tick cannot re-shuttle the
      // still-pending row inside the spawn duplicate-window, so the shaped
      // outcome is a DUPLICATE_SPAWN envelope (the deferred re-spawn
      // concern). Pinning the concrete code documents current behavior —
      // the provider-idempotency work will flip this test.
      assert.equal(res.response.status, "error");
      if (res.response.status === "error") {
        assert.equal(res.response.code, "DUPLICATE_SPAWN");
      }
      // The recovery ledger row exists with a materialized blob — proof
      // the recovery applied (committed) and its response was cached for
      // replay, independent of the FSM re-tick outcome.
      const row = await withStateTransaction(h.dir, captureNow(), (tx) =>
        tx.queryRow<{ response_blob: unknown }>(
          "SELECT response_blob FROM kernel_idempotency_ledger WHERE key = ?",
          [`recovery:${driver_state_id}:retry-failed:${res.recovery_id}`],
        ),
      );
      assert.notEqual(row, null);
      assert.notEqual(row?.response_blob, null);
    } finally {
      cleanup(h.dir);
    }
  });

  it("a re-entrant choice without a registry is refused; a terminal choice still works", async () => {
    const h = await freshHarness();
    try {
      const { driver_state_id } = await bootstrap(h, "uuid-r10");
      // No resolveRegistry wired — the re-entrant path has no flow to tick.
      const recover = createRecoverTool({ allowlistPath: h.allowlistPath });
      const reentrant = await recover({ project_dir: h.dir, driver_state_id, choice: "cancel-pending" });
      assert.equal(reentrant.response.status, "error");
      if (reentrant.response.status === "error") {
        assert.equal(reentrant.response.code, "REGISTRY_UNAVAILABLE");
      }
      // The terminal choice shapes its response with no FSM tick, so it
      // succeeds even without a registry.
      const terminal = await recover({ project_dir: h.dir, driver_state_id, choice: "abandon" });
      assert.equal(terminal.response.status, "complete");
      const state = await withStateTransaction(h.dir, captureNow(), loadState);
      assert.equal(state.status, "abandoned");
    } finally {
      cleanup(h.dir);
    }
  });

  it("cross-owner recovery is refused with CROSS_OWNER_MARKER_REQUIRED", async () => {
    const h = await freshHarness();
    try {
      const { driver_state_id } = await bootstrap(h, "uuid-r6", "alice");
      const { recover } = tools(h);
      const res = await recover({
        project_dir: h.dir,
        driver_state_id,
        choice: "abandon",
        owner_id: "bob",
      });
      assert.equal(res.response.status, "error");
      if (res.response.status === "error") {
        assert.equal(res.response.code, "CROSS_OWNER_MARKER_REQUIRED");
      }
    } finally {
      cleanup(h.dir);
    }
  });

  it("replaying the same recovery_id returns the identical envelope and mutates nothing", async () => {
    const h = await freshHarness();
    try {
      const { driver_state_id } = await bootstrap(h, "uuid-r7");
      const { recover } = tools(h);
      const recoveryId = makeRecoveryId();
      const first = await recover({ project_dir: h.dir, driver_state_id, choice: "abandon", recovery_id: recoveryId });
      const afterFirst = await withStateTransaction(h.dir, captureNow(), loadState);

      const second = await recover({ project_dir: h.dir, driver_state_id, choice: "abandon", recovery_id: recoveryId });
      const afterReplay = await withStateTransaction(h.dir, captureNow(), loadState);

      assert.deepEqual(second.response, first.response);
      assert.equal(second.recovery_id, first.recovery_id);
      assert.equal(second.recovery_id, recoveryId);
      // The replay re-mutated nothing — the close timestamp is pinned.
      assert.equal(afterReplay.status, afterFirst.status);
      assert.equal(afterReplay.ended_at, afterFirst.ended_at);
    } finally {
      cleanup(h.dir);
    }
  });

  it("an allowlist miss is refused with PROJECT_DIR_NOT_ALLOWED", async () => {
    const h = await freshHarness();
    try {
      const { driver_state_id } = await bootstrap(h, "uuid-r8");
      const recover = createRecoverTool({
        resolveRegistry: () => h.registry,
        allowlistPath: join(h.dir, "nonexistent.allow"),
      });
      const res = await recover({ project_dir: h.dir, driver_state_id, choice: "abandon" });
      assert.equal(res.response.status, "error");
      if (res.response.status === "error") {
        assert.equal(res.response.code, "PROJECT_DIR_NOT_ALLOWED");
      }
      assert.match(res.recovery_id, /^rec-/);
    } finally {
      cleanup(h.dir);
    }
  });

  it("co-commits a pipeline_recover audit row carrying the unverified caller", async () => {
    const h = await freshHarness();
    try {
      const { driver_state_id } = await bootstrap(h, "uuid-r9");
      const { recover } = tools(h);
      await recover({
        project_dir: h.dir,
        driver_state_id,
        choice: "abandon",
        client_identifier_unverified: "custom:test-client",
      });
      const row = await withStateTransaction(h.dir, captureNow(), (tx) =>
        tx.queryRow<{ payload: unknown }>(
          "SELECT payload FROM audit WHERE type = 'pipeline_recover' ORDER BY id DESC LIMIT 1",
        ),
      );
      assert.notEqual(row, null);
      const payload = JSON.parse(String(row?.payload)) as Record<string, unknown>;
      assert.equal(payload["client_identifier_unverified"], "custom:test-client");
      assert.equal(payload["choice"], "abandon");
    } finally {
      cleanup(h.dir);
    }
  });
});
