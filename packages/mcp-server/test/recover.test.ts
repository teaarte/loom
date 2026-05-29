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

import {
  createIssueCrossOwnerMarkerTool,
  createRecoverTool,
  createRunTaskTool,
} from "../src/index.js";

const FIXED_NOW = "2026-05-28T10:00:00.000Z";

// A ≥32-byte signing key for the cross-owner marker tests.
const ENV_KEY = Buffer.alloc(32, 0xc3).toString("base64");

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

function stubProvider(idempotent = true): LLMProvider {
  return {
    name: "stub",
    capabilities: { execution: "shuttle", idempotent_spawn: idempotent, reports_usage: false },
    async spawn() {
      throw new Error("stub provider spawn must not be called from the transport test");
    },
  };
}

function buildRegistry(idempotent = true): Registry {
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
  const provider = stubProvider(idempotent);
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

async function freshHarness(idempotent = true): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "loom-recover-mcp-"));
  openDb(dir);
  await reconcileExtensions({
    manifests: [bundleManifest("code-fixture")],
    project_dir: dir,
    now: FIXED_NOW as never,
  });
  const allowlistPath = join(dir, "projects.allow");
  writeFileSync(allowlistPath, `${realpathSync(dir)}\n`, "utf8");
  return { dir, allowlistPath, registry: buildRegistry(idempotent) };
}

function cleanup(dir: string): void {
  try {
    closeDb(dir);
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
}

function restoreServerEnv(prev: string | undefined): void {
  if (prev === undefined) delete process.env["PIPELINE_BYPASS_HMAC_KEY"];
  else process.env["PIPELINE_BYPASS_HMAC_KEY"] = prev;
}

function tools(h: Harness) {
  const deps = { resolveRegistry: () => h.registry, allowlistPath: h.allowlistPath };
  return {
    run: createRunTaskTool(deps),
    recover: createRecoverTool(deps),
    issueMarker: createIssueCrossOwnerMarkerTool({ allowlistPath: h.allowlistPath }),
  };
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

  it("retry-failed re-shuttles the named pending row reusing its agent_run_id (no DUPLICATE_SPAWN)", async () => {
    const h = await freshHarness(true); // idempotent provider
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
      // The named pending row is re-launched WITHOUT a fresh begin_spawn —
      // reusing the existing agent_run_id, so the duplicate-window guard is
      // never consulted. The directive is a spawn, not a DUPLICATE_SPAWN.
      assert.equal(res.response.status, "spawn-agent");
      if (res.response.status === "spawn-agent") {
        assert.equal(res.response.agent_run_id, agent_run_id);
        assert.equal(res.response.agent, "impl-1");
      }
      // The recovery ledger row exists with a materialized blob.
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

  it("retry-failed against a non-idempotent provider is refused with PROVIDER_NOT_IDEMPOTENT", async () => {
    const h = await freshHarness(false); // non-idempotent provider
    try {
      const { driver_state_id, agent_run_id } = await bootstrap(h, "uuid-r5b");
      const { recover } = tools(h);
      const res = await recover({
        project_dir: h.dir,
        driver_state_id,
        choice: "retry-failed",
        agent_run_ids: [agent_run_id],
      });
      assert.equal(res.response.status, "error");
      if (res.response.status === "error") {
        assert.equal(res.response.code, "PROVIDER_NOT_IDEMPOTENT");
      }
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

  it("cross-owner recovery without a marker is refused with CROSS_OWNER_REQUIRED", async () => {
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
        assert.equal(res.response.code, "CROSS_OWNER_REQUIRED");
      }
    } finally {
      cleanup(h.dir);
    }
  });

  it("a valid issued marker authorizes a cross-owner recovery", async () => {
    const prevEnv = process.env["PIPELINE_BYPASS_HMAC_KEY"];
    process.env["PIPELINE_BYPASS_HMAC_KEY"] = ENV_KEY;
    const h = await freshHarness();
    try {
      const { driver_state_id } = await bootstrap(h, "uuid-r6b", "alice");
      const { recover, issueMarker } = tools(h);
      const issued = await issueMarker({ project_dir: h.dir, driver_state_id, ttl_ms: 60_000 });
      assert.equal(issued.error, undefined);
      assert.ok(issued.hmac !== null && issued.reason !== null);

      const res = await recover({
        project_dir: h.dir,
        driver_state_id,
        choice: "abandon",
        owner_id: "bob",
        marker: {
          issued_at: issued.issued_at as string,
          expires_at: issued.expires_at as string,
          reason: issued.reason as string,
          hmac: issued.hmac as string,
          key_id: issued.key_id as string,
        },
      });
      assert.equal(res.response.status, "complete");
      const state = await withStateTransaction(h.dir, captureNow(), loadState);
      assert.equal(state.status, "abandoned");
    } finally {
      restoreServerEnv(prevEnv);
      cleanup(h.dir);
    }
  });

  it("a forged marker is refused with CROSS_OWNER_MARKER_INVALID", async () => {
    const prevEnv = process.env["PIPELINE_BYPASS_HMAC_KEY"];
    process.env["PIPELINE_BYPASS_HMAC_KEY"] = ENV_KEY;
    const h = await freshHarness();
    try {
      const { driver_state_id } = await bootstrap(h, "uuid-r6c", "alice");
      const { recover, issueMarker } = tools(h);
      const issued = await issueMarker({ project_dir: h.dir, driver_state_id, ttl_ms: 60_000 });
      const res = await recover({
        project_dir: h.dir,
        driver_state_id,
        choice: "abandon",
        owner_id: "bob",
        marker: {
          issued_at: issued.issued_at as string,
          expires_at: issued.expires_at as string,
          reason: issued.reason as string,
          hmac: "0".repeat(64), // tampered signature
          key_id: issued.key_id as string,
        },
      });
      assert.equal(res.response.status, "error");
      if (res.response.status === "error") {
        assert.equal(res.response.code, "CROSS_OWNER_MARKER_INVALID");
      }
      // The forged attempt did not consume the genuine marker row.
      const state = await withStateTransaction(h.dir, captureNow(), loadState);
      assert.equal(state.status, "in_progress");
    } finally {
      restoreServerEnv(prevEnv);
      cleanup(h.dir);
    }
  });

  it("a consumed marker replayed under a fresh recovery_id is CROSS_OWNER_MARKER_CONSUMED", async () => {
    const prevEnv = process.env["PIPELINE_BYPASS_HMAC_KEY"];
    process.env["PIPELINE_BYPASS_HMAC_KEY"] = ENV_KEY;
    const h = await freshHarness();
    try {
      const { driver_state_id } = await bootstrap(h, "uuid-r6d", "alice");
      const { recover, issueMarker } = tools(h);
      const issued = await issueMarker({ project_dir: h.dir, driver_state_id, ttl_ms: 60_000 });
      const marker = {
        issued_at: issued.issued_at as string,
        expires_at: issued.expires_at as string,
        reason: issued.reason as string,
        hmac: issued.hmac as string,
        key_id: issued.key_id as string,
      };
      // First use consumes the marker (fresh recovery_id minted).
      const first = await recover({
        project_dir: h.dir,
        driver_state_id,
        choice: "abandon",
        owner_id: "bob",
        marker,
      });
      assert.equal(first.response.status, "complete");
      // Replay with the SAME marker but a DIFFERENT recovery_id — the
      // recovery-ledger replay does not fire, so the owner guard runs and
      // finds the marker already consumed.
      const second = await recover({
        project_dir: h.dir,
        driver_state_id,
        choice: "abandon",
        owner_id: "bob",
        recovery_id: makeRecoveryId(),
        marker,
      });
      assert.equal(second.response.status, "error");
      if (second.response.status === "error") {
        assert.equal(second.response.code, "CROSS_OWNER_MARKER_CONSUMED");
      }
    } finally {
      restoreServerEnv(prevEnv);
      cleanup(h.dir);
    }
  });

  it("issuing a marker with no signing key is refused with BYPASS_KEY_MISSING", async () => {
    const prevEnv = process.env["PIPELINE_BYPASS_HMAC_KEY"];
    const prevHome = process.env["HOME"];
    delete process.env["PIPELINE_BYPASS_HMAC_KEY"];
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "loom-recover-emptyhome-"));
    const h = await freshHarness();
    try {
      const { driver_state_id } = await bootstrap(h, "uuid-r6e", "alice");
      const { issueMarker } = tools(h);
      const issued = await issueMarker({ project_dir: h.dir, driver_state_id, ttl_ms: 60_000 });
      assert.equal(issued.hmac, null);
      assert.equal(issued.error?.code, "BYPASS_KEY_MISSING");
    } finally {
      restoreServerEnv(prevEnv);
      if (prevHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = prevHome;
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

  it("an idempotent abandon tags the audit row error_class=recovery-idempotent", async () => {
    const h = await freshHarness();
    try {
      const { driver_state_id } = await bootstrap(h, "uuid-r11");
      const { recover } = tools(h);
      // First abandon closes the task (applied → no error_class).
      await recover({ project_dir: h.dir, driver_state_id, choice: "abandon" });
      // A second abandon (fresh recovery_id) finds a terminal task → no
      // state change → tagged recovery-idempotent.
      await recover({ project_dir: h.dir, driver_state_id, choice: "abandon" });
      const row = await withStateTransaction(h.dir, captureNow(), (tx) =>
        tx.queryRow<{ error_class: unknown }>(
          "SELECT error_class FROM audit WHERE type = 'pipeline_recover' ORDER BY id DESC LIMIT 1",
        ),
      );
      assert.equal(row?.error_class, "recovery-idempotent");
    } finally {
      cleanup(h.dir);
    }
  });

  it("a raced cancel-pending tags the audit row error_class=recovery-raced", async () => {
    const h = await freshHarness();
    try {
      const { driver_state_id } = await bootstrap(h, "uuid-r12");
      const { recover } = tools(h);
      // Simulate a racing delivery that already drained the pending row,
      // so this cancel-pending finds nothing outstanding → recovery-raced.
      await withStateTransaction(h.dir, captureNow(), (tx) =>
        tx.exec("DELETE FROM pending_agents"),
      );
      await recover({ project_dir: h.dir, driver_state_id, choice: "cancel-pending" });
      const row = await withStateTransaction(h.dir, captureNow(), (tx) =>
        tx.queryRow<{ error_class: unknown }>(
          "SELECT error_class FROM audit WHERE type = 'pipeline_recover' ORDER BY id DESC LIMIT 1",
        ),
      );
      assert.equal(row?.error_class, "recovery-raced");
    } finally {
      cleanup(h.dir);
    }
  });
});
