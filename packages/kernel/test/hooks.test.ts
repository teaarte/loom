import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  HookRunner,
  type HookCandidate,
  type HookLedger,
  type HookMarker,
} from "../src/hook-runner.js";
import {
  indexHooksByEvent,
  resolveHooks,
  topoSortHooks,
} from "../src/hooks.js";
import { _resetInvariantsForTest } from "../src/invariants.js";
import {
  KernelError,
  captureNow,
  closeDb,
  withStateTransaction,
} from "../src/state.js";
import type { Bundle } from "../src/types/bundle.js";
import type { HookContext } from "../src/types/context.js";
import type { NowToken } from "../src/types/now.js";
import type { Policy, PolicyName } from "../src/types/policy.js";
import type { Hook } from "../src/types/plugins.js";
import type { LLMProvider } from "../src/types/provider.js";
import type { Registry } from "../src/types/registry.js";
import type { GateRole } from "../src/types/row-types.js";
import type { BundleStateView } from "../src/types/state.js";

// ============================================================================
// Fixtures
// ============================================================================

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "loom-hooks-"));
}

function cleanup(projectDir: string): void {
  try {
    closeDb(projectDir);
  } catch {
    /* may have already closed */
  }
  rmSync(projectDir, { recursive: true, force: true });
}

function noopHook(name: string, overrides: Partial<Hook> = {}): Hook {
  const base: Hook = {
    name,
    event: "after-spawn",
    idempotent: true,
    async run() {
      /* noop */
    },
  };
  return { ...base, ...overrides };
}

function emptyBundle(hooks: Hook[]): Bundle {
  return {
    name: "stub",
    version: "0.0.1",
    description: "hooks fixture",
    phases: ["p1"],
    default_flow: "default",
    default_gate_policies: {} as Record<GateRole, PolicyName>,
    gate_roles: {},
    agents: [],
    stages: {},
    flows: { default: [] },
    hooks,
    invariants: [],
  };
}

function buildRegistry(hooks: Hook[]): Registry {
  const stubProvider: LLMProvider = {
    name: "stub",
    capabilities: {
      execution: "shuttle",
      idempotent_spawn: true,
      reports_usage: true,
    },
    async spawn() {
      throw new Error("stub — spawn must not run in this test");
    },
  };
  return {
    bundle: emptyBundle(hooks),
    agents: new Map(),
    stages: new Map(),
    flows: new Map([["default", []]]),
    hooks,
    invariants: [],
    mcp_clients: new Map(),
    providers: {
      resolve: () => stubProvider,
      all: [stubProvider],
      health_check_all: Promise.resolve([{ name: "stub", healthy: true }]),
    },
    policyFactories: new Map<PolicyName, () => Policy>(),
  };
}

async function seedBaseline(
  projectDir: string,
  driverStateId: string,
  taskId: string,
): Promise<NowToken> {
  const now = captureNow();
  await withStateTransaction(projectDir, now, async (tx) => {
    await tx.exec(
      "INSERT INTO pipeline_state (id, schema_version, project_dir, bundle, " +
        "task, task_id, driver_state_id, status, verdict, started_at) " +
        "VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "3.0.0",
        projectDir,
        "stub",
        "hooks fixture",
        taskId,
        driverStateId,
        "in_progress",
        null,
        now,
      ],
    );
    await tx.exec(
      "INSERT INTO driver_state (id, flow_name, step_index, complete) " +
        "VALUES (1, ?, 0, 0)",
      ["default"],
    );
    await tx.exec("INSERT INTO pipeline_counters (id) VALUES (1)");
    await tx.exec(
      "INSERT INTO phases (name, status, skipped_reason, updated_at) " +
        "VALUES ('p1', 'pending', NULL, ?)",
      [now],
    );
  });
  return now;
}

function buildState(
  projectDir: string,
  now: NowToken,
  driverStateId: string,
  taskId: string,
): BundleStateView {
  return {
    task_id: taskId,
    driver_state_id: driverStateId,
    project_dir: projectDir,
    bundle: "stub",
    task: "hooks fixture",
    task_short: null,
    owner_id: null,
    status: "in_progress",
    verdict: null,
    started_at: now,
    ended_at: null,
    gate_policies: {} as Record<GateRole, PolicyName>,
    decisions: {},
    bundle_state: null,
    stack: null,
    pipeline_violation: null,
    force_used: false,
    agents_count: 0,
    gate_revisions: {} as Record<GateRole, number>,
    gate_auto_rejections: {} as Record<GateRole, number>,
    files_created: [],
    files_modified: [],
    total_tokens_in: 0,
    total_tokens_out: 0,
    total_tokens_cached: 0,
    phases: [
      {
        name: "p1",
        status: "pending",
        skipped_reason: null,
        phase_extension: null,
        updated_at: now,
      },
    ],
    gates: {},
    agent_verdicts: [],
    pending_agents: [],
    now,
  };
}

function buildCtx(
  state: BundleStateView,
  correlation: string,
  overrides: Partial<HookContext> = {},
): HookContext {
  return {
    registry: buildRegistry([]),
    bundle: emptyBundle([]),
    provider_registry: {
      resolve: () => {
        throw new Error("unused");
      },
      all: [],
      health_check_all: Promise.resolve([]),
    },
    now: state.now,
    state,
    idem_correlation: correlation,
    async emit_event() {},
    findings: {
      query: () => [],
      countBlocking: () => 0,
      queryByPhase: () => [],
    },
    audit_query: { recent: () => [] },
    agents_query: { query: () => [] },
    ...overrides,
  };
}

// Stub ledger — no SQLite round-trip, useful for asserting dispatch
// order and filter behavior in isolation.
class StubLedger implements HookLedger {
  scanned: HookCandidate[] = [];
  written: HookMarker[] = [];
  async scanExisting(
    candidates: ReadonlyArray<HookCandidate>,
    _ctx: HookContext,
  ): Promise<Set<string>> {
    for (const c of candidates) this.scanned.push(c);
    return new Set();
  }
  async writeMarkers(
    markers: ReadonlyArray<HookMarker>,
    _ctx: HookContext,
  ): Promise<void> {
    for (const m of markers) this.written.push(m);
  }
}

// ============================================================================
// topoSortHooks
// ============================================================================

describe("topoSortHooks", () => {
  it("orders a linear chain A → B → C as [A, B, C]", () => {
    const a = noopHook("A");
    const b = noopHook("B", { requires: ["A"] });
    const c = noopHook("C", { requires: ["B"] });
    const sorted = topoSortHooks([c, a, b]).map((h) => h.name);
    assert.deepEqual(sorted, ["A", "B", "C"]);
  });

  it("orders a diamond A→B, A→C, B→D, C→D with A first and D last", () => {
    const a = noopHook("A");
    const b = noopHook("B", { requires: ["A"] });
    const c = noopHook("C", { requires: ["A"] });
    const d = noopHook("D", { requires: ["B", "C"] });
    const sorted = topoSortHooks([a, b, c, d]).map((h) => h.name);
    assert.equal(sorted[0], "A");
    assert.equal(sorted[sorted.length - 1], "D");
    // B and C order follows input registration.
    const bIdx = sorted.indexOf("B");
    const cIdx = sorted.indexOf("C");
    assert.ok(bIdx < cIdx, `B should precede C; got ${sorted.join(",")}`);
  });

  it("tie-breaks ready peers by input order", () => {
    const a = noopHook("A");
    const b = noopHook("B", { requires: ["A"] });
    const c = noopHook("C", { requires: ["A"] });
    const sorted = topoSortHooks([a, b, c]).map((h) => h.name);
    assert.deepEqual(sorted, ["A", "B", "C"]);
    const reversed = topoSortHooks([a, c, b]).map((h) => h.name);
    assert.deepEqual(reversed, ["A", "C", "B"]);
  });

  it("throws HOOK_CYCLE with the cycle vertices on a cyclic graph", () => {
    const a = noopHook("A", { requires: ["B"] });
    const b = noopHook("B", { requires: ["A"] });
    assert.throws(
      () => topoSortHooks([a, b]),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "HOOK_CYCLE");
        const detail = (err as KernelError).detail;
        assert.ok(detail !== undefined);
        const cycle = detail["cycle"] as string[];
        assert.deepEqual(new Set(cycle), new Set(["A", "B"]));
        return true;
      },
    );
  });

  it("throws HOOK_REQUIRES_UNKNOWN when a dependency name is not registered", () => {
    const b = noopHook("B", { requires: ["ghost"] });
    assert.throws(
      () => topoSortHooks([b]),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "HOOK_REQUIRES_UNKNOWN");
        const detail = (err as KernelError).detail;
        assert.ok(detail !== undefined);
        assert.equal(detail["hook"], "B");
        assert.equal(detail["missing"], "ghost");
        return true;
      },
    );
  });

  it("throws HOOK_NAME_DUPLICATE when two hooks share the same name", () => {
    const a1 = noopHook("dup");
    const a2 = noopHook("dup");
    assert.throws(
      () => topoSortHooks([a1, a2]),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "HOOK_NAME_DUPLICATE");
        return true;
      },
    );
  });
});

// ============================================================================
// resolveHooks
// ============================================================================

describe("resolveHooks", () => {
  it("exact event match returns only the exact-list hooks", () => {
    const a = noopHook("A", { event: "after-spawn" });
    const b = noopHook("B", { event: "before-spawn" });
    const index = indexHooksByEvent([a, b]);
    const out = resolveHooks("after-spawn", index).map((h) => h.name);
    assert.deepEqual(out, ["A"]);
  });

  it("RegExp event hook matches the pattern, not unrelated events", () => {
    const r = noopHook("R", { event: /^after-/ });
    const index = indexHooksByEvent([r]);
    assert.deepEqual(
      resolveHooks("after-spawn", index).map((h) => h.name),
      ["R"],
    );
    assert.deepEqual(
      resolveHooks("after-finalize", index).map((h) => h.name),
      ["R"],
    );
    assert.deepEqual(
      resolveHooks("before-spawn", index).map((h) => h.name),
      [],
    );
  });

  it("returns empty list for an empty index", () => {
    const index = indexHooksByEvent([]);
    assert.deepEqual(resolveHooks("after-spawn", index), []);
  });
});

// ============================================================================
// HookRunner.fire — integration against real SQLite
// ============================================================================

describe("HookRunner.fire", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("persists a ledger row keyed side-effect-hook:<name>:<corr> after a fire", async () => {
    let ran = 0;
    const h: Hook = {
      name: "audit-1",
      event: "after-spawn",
      idempotent: true,
      async run() {
        ran += 1;
      },
    };
    const runner = new HookRunner(buildRegistry([h]));
    const now = await seedBaseline(projectDir, "d-fire-1", "t-fire-1");
    const state = buildState(projectDir, now, "d-fire-1", "t-fire-1");
    const ctx = buildCtx(state, "pre-or-post:d-fire-1:0");

    await runner.fire("after-spawn", ctx);

    assert.equal(ran, 1);

    const rows = await withStateTransaction(projectDir, now, async (tx) => {
      return tx.queryAll<{ key: string }>(
        "SELECT key FROM kernel_idempotency_ledger WHERE key LIKE 'side-effect-hook:%'",
      );
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.key, "side-effect-hook:audit-1:pre-or-post:d-fire-1:0");
  });

  it("skips a hook on the second fire for the same (event, correlation)", async () => {
    let ran = 0;
    const h: Hook = {
      name: "audit-2",
      event: "after-spawn",
      idempotent: true,
      async run() {
        ran += 1;
      },
    };
    const runner = new HookRunner(buildRegistry([h]));
    const now = await seedBaseline(projectDir, "d-fire-2", "t-fire-2");
    const state = buildState(projectDir, now, "d-fire-2", "t-fire-2");
    const ctx = buildCtx(state, "pre-or-post:d-fire-2:0");

    await runner.fire("after-spawn", ctx);
    await runner.fire("after-spawn", ctx);

    assert.equal(ran, 1, "second fire must skip — ledger dedup");
  });

  it("records a thrown hook as failed: audit row lands AND fire does not reject", async () => {
    const h: Hook = {
      name: "thrower",
      event: "after-spawn",
      idempotent: true,
      async run() {
        throw new Error("boom");
      },
    };
    const runner = new HookRunner(buildRegistry([h]));
    const now = await seedBaseline(projectDir, "d-fail-1", "t-fail-1");
    const state = buildState(projectDir, now, "d-fail-1", "t-fail-1");
    const ctx = buildCtx(state, "pre-or-post:d-fail-1:0");

    await runner.fire("after-spawn", ctx);

    const auditRows = await withStateTransaction(projectDir, now, async (tx) =>
      tx.queryAll<{ type: string; error_class: string | null; payload: string }>(
        "SELECT type, error_class, payload FROM audit WHERE type = 'hook-failure'",
      ),
    );
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0]?.type, "hook-failure");
    assert.equal(auditRows[0]?.error_class, "hook-failure");
    const payload = JSON.parse(auditRows[0]?.payload ?? "{}") as Record<string, unknown>;
    assert.equal(payload["hook"], "thrower");
    assert.equal(payload["error"], "boom");

    const ledgerRows = await withStateTransaction(projectDir, now, async (tx) =>
      tx.queryAll<{ key: string; hook_results_json: string | null }>(
        "SELECT key, hook_results_json FROM kernel_idempotency_ledger WHERE key LIKE 'side-effect-hook:%'",
      ),
    );
    assert.equal(ledgerRows.length, 1);
    const results = JSON.parse(ledgerRows[0]?.hook_results_json ?? "{}") as Record<
      string,
      unknown
    >;
    assert.equal(results["error_class"], "hook-failure");
    assert.equal(results["error"], "boom");
  });

  it("executes two hooks with requires:[A] AFTER A in topo order", async () => {
    const order: string[] = [];
    const a: Hook = {
      name: "A",
      event: "after-spawn",
      idempotent: true,
      async run() {
        order.push("A");
      },
    };
    const b: Hook = {
      name: "B",
      event: "after-spawn",
      idempotent: true,
      requires: ["A"],
      async run() {
        order.push("B");
      },
    };
    const c: Hook = {
      name: "C",
      event: "after-spawn",
      idempotent: true,
      requires: ["A"],
      async run() {
        order.push("C");
      },
    };
    const runner = new HookRunner(buildRegistry([a, b, c]));
    runner.setLedger(new StubLedger());
    const now = captureNow();
    const state = buildState(projectDir, now, "d-order-1", "t-order-1");
    const ctx = buildCtx(state, "pre-or-post:d-order-1:0");

    await runner.fire("after-spawn", ctx);

    assert.deepEqual(order, ["A", "B", "C"]);
  });

  it("filter narrows: 'stage-x' filter does not match ctx.stage='stage-y'", async () => {
    const ran: string[] = [];
    const matching: Hook = {
      name: "match",
      event: "after-spawn",
      filter: "stage-y",
      idempotent: true,
      async run() {
        ran.push("match");
      },
    };
    const skipped: Hook = {
      name: "skip",
      event: "after-spawn",
      filter: "stage-x",
      idempotent: true,
      async run() {
        ran.push("skip");
      },
    };
    const runner = new HookRunner(buildRegistry([matching, skipped]));
    runner.setLedger(new StubLedger());
    const now = captureNow();
    const state = buildState(projectDir, now, "d-filter-1", "t-filter-1");
    const ctx = buildCtx(state, "pre-or-post:d-filter-1:0", { stage: "stage-y" });

    await runner.fire("after-spawn", ctx);

    assert.deepEqual(ran, ["match"]);
  });

  it("calls scanExisting exactly once and writeMarkers exactly once per fire — 2 tx contract", async () => {
    // Three hooks fire on the same event. The load-bearing perf
    // contract is "constant tx cost per fire regardless of hook
    // count" — verified by counting ledger-method calls (each
    // KernelHookLedger method opens exactly one tx; a stub mirrors
    // that cardinality without touching SQLite).
    const hooks: Hook[] = [
      {
        name: "h1",
        event: "after-spawn",
        idempotent: true,
        async run() {},
      },
      {
        name: "h2",
        event: "after-spawn",
        idempotent: true,
        async run() {},
      },
      {
        name: "h3",
        event: "after-spawn",
        idempotent: true,
        async run() {},
      },
    ];
    const runner = new HookRunner(buildRegistry(hooks));
    const stub = new StubLedger();
    let scanCalls = 0;
    let writeCalls = 0;
    runner.setLedger({
      async scanExisting(c, ctx) {
        scanCalls += 1;
        return stub.scanExisting(c, ctx);
      },
      async writeMarkers(m, ctx) {
        writeCalls += 1;
        return stub.writeMarkers(m, ctx);
      },
    });
    const now = captureNow();
    const state = buildState(projectDir, now, "d-2tx-1", "t-2tx-1");
    const ctx = buildCtx(state, "pre-or-post:d-2tx-1:0");

    await runner.fire("after-spawn", ctx);

    assert.equal(scanCalls, 1, "scanExisting must be called exactly once per fire");
    assert.equal(writeCalls, 1, "writeMarkers must be called exactly once per fire");
    assert.equal(stub.scanned.length, 3, "scan batch must include every candidate");
    assert.equal(stub.written.length, 3, "write batch must include every marker");
  });

  it("runs only hooks whose pair was not already in the ledger (partial dedup)", async () => {
    const ran: string[] = [];
    const hooks: Hook[] = ["A", "B", "C"].map((n) => ({
      name: n,
      event: "after-spawn",
      idempotent: true,
      async run() {
        ran.push(n);
      },
    }));
    const runner = new HookRunner(buildRegistry(hooks));
    // Stub ledger reports B as already-seen; A and C should run.
    runner.setLedger({
      async scanExisting() {
        return new Set(["B:pre-or-post:d-partial:0"]);
      },
      async writeMarkers() {},
    });
    const now = captureNow();
    const state = buildState(projectDir, now, "d-partial", "t-partial");
    const ctx = buildCtx(state, "pre-or-post:d-partial:0");

    await runner.fire("after-spawn", ctx);

    assert.deepEqual(ran, ["A", "C"]);
  });

  it("batches mixed ok + failed markers from one fire into a single write", async () => {
    // Two hooks fire on the same event; one throws, one succeeds.
    // Both markers must land in the ledger and the audit row for
    // the thrower must be emitted — proving the batch write-tx
    // does not abort on a single hook's failure marker.
    const ok: Hook = {
      name: "ok-hook",
      event: "after-spawn",
      idempotent: true,
      async run() {},
    };
    const bad: Hook = {
      name: "bad-hook",
      event: "after-spawn",
      idempotent: true,
      async run() {
        throw new Error("kaboom");
      },
    };
    const runner = new HookRunner(buildRegistry([ok, bad]));
    const now = await seedBaseline(projectDir, "d-mixed-1", "t-mixed-1");
    const state = buildState(projectDir, now, "d-mixed-1", "t-mixed-1");
    const ctx = buildCtx(state, "pre-or-post:d-mixed-1:0");

    await runner.fire("after-spawn", ctx);

    const ledger = await withStateTransaction(projectDir, now, async (tx) =>
      tx.queryAll<{ key: string; hook_results_json: string | null }>(
        "SELECT key, hook_results_json FROM kernel_idempotency_ledger " +
          "WHERE key LIKE 'side-effect-hook:%' ORDER BY key",
      ),
    );
    assert.equal(ledger.length, 2);
    const byKey = new Map(ledger.map((r) => [r.key, r.hook_results_json]));
    assert.equal(
      byKey.get("side-effect-hook:ok-hook:pre-or-post:d-mixed-1:0"),
      null,
      "ok marker carries no hook_results_json",
    );
    const badResults = byKey.get("side-effect-hook:bad-hook:pre-or-post:d-mixed-1:0");
    assert.ok(badResults !== null && badResults !== undefined);
    assert.match(badResults, /"error_class":"hook-failure"/);
    assert.match(badResults, /"error":"kaboom"/);

    const audit = await withStateTransaction(projectDir, now, async (tx) =>
      tx.queryAll<{ count: number }>(
        "SELECT COUNT(*) AS count FROM audit WHERE type = 'hook-failure'",
      ),
    );
    assert.equal(Number(audit[0]?.count), 1, "only the failed hook produces an audit row");
  });

  it("function-predicate filter receives the ctx and gates execution", async () => {
    // K5 contract: when `filter` is a function, it's called with
    // the full HookContext. Round-trip the contract through fire()
    // and assert the predicate's verdict actually controls dispatch.
    let received: HookContext | null = null;
    const h: Hook = {
      name: "fn-filter",
      event: "after-spawn",
      idempotent: true,
      filter: (c) => {
        received = c;
        return c.stage === "stage-z";
      },
      async run() {},
    };
    const runner = new HookRunner(buildRegistry([h]));
    const stub = new StubLedger();
    runner.setLedger(stub);
    const now = captureNow();
    const state = buildState(projectDir, now, "d-fnfilter-1", "t-fnfilter-1");

    // Predicate returns false → hook is filtered out → no marker.
    await runner.fire(
      "after-spawn",
      buildCtx(state, "pre-or-post:d-fnfilter-1:0", { stage: "stage-other" }),
    );
    assert.notEqual(received, null, "filter must be invoked");
    assert.equal(stub.written.length, 0);

    // Predicate returns true → hook runs → marker recorded.
    await runner.fire(
      "after-spawn",
      buildCtx(state, "pre-or-post:d-fnfilter-1:1", { stage: "stage-z" }),
    );
    assert.equal(stub.written.length, 1);
    assert.equal(stub.written[0]?.name, "fn-filter");
  });

  it("throws HOOK_CYCLE from the constructor when registry.hooks is cyclic", () => {
    const a: Hook = {
      name: "A",
      event: "after-spawn",
      idempotent: true,
      requires: ["B"],
      async run() {},
    };
    const b: Hook = {
      name: "B",
      event: "after-spawn",
      idempotent: true,
      requires: ["A"],
      async run() {},
    };
    const registry = buildRegistry([a, b]);
    assert.throws(
      () => new HookRunner(registry),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "HOOK_CYCLE");
        return true;
      },
    );
  });
});
