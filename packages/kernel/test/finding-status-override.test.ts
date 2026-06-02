import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { applyBundleOps } from "../src/lib/apply-bundle-ops.js";
import { buildStageContext } from "../src/fsm.js";
import { materializeAccessSnapshot } from "../src/lib/access-snapshots.js";
import { _resetInvariantsForTest } from "../src/invariants.js";
import { buildVocabularies } from "../src/vocabularies.js";
import {
  KernelError,
  closeDb,
  loadState,
  openDb,
  withStateTransaction,
} from "../src/state.js";
import type { Bundle } from "../src/types/bundle.js";
import type { BundleOp } from "../src/types/context.js";
import type { NowToken } from "../src/types/now.js";
import type { Policy, PolicyName } from "../src/types/policy.js";
import type { LLMProvider } from "../src/types/provider.js";
import type { Registry } from "../src/types/registry.js";
import type { GateRole } from "../src/types/row-types.js";
import type { PipelineState } from "../src/types/state.js";

// Generic finding-status override mutator (`update_finding_status`). The
// kernel sets only the lifecycle columns `countBlocking` / `inv008` read for
// liveness; the bundle owns which finding and which target state. These specs
// prove the GENERIC transition — they name no domain concept — and each is
// redden-on-revert: neutralise the applier arm and the assertion fails.

const NOW = "2026-06-02T10:00:00.000Z" as NowToken;
const DRIVER = "d-override";

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "loom-override-"));
}

function cleanup(dir: string): void {
  try {
    closeDb(dir);
  } catch {
    /* may already be closed */
  }
  rmSync(dir, { recursive: true, force: true });
}

// Seed a terminal-swept phase so ONLY the acceptance veto can object to an
// accepted verdict — the same isolation the supersede veto spec uses.
async function seed(dir: string): Promise<void> {
  await withStateTransaction(dir, NOW, async (tx) => {
    await tx.exec(
      "INSERT INTO pipeline_state (id, schema_version, project_dir, bundle, task_id, " +
        "task, driver_state_id, status, verdict, started_at, gate_policies, decisions) " +
        "VALUES (1, '3.0.0', ?, 'code-fixture', 't-2026-06-02-ovr', 'seeded task', ?, " +
        "'in_progress', NULL, ?, '{}', '{}')",
      [dir, DRIVER, NOW],
    );
    await tx.exec(
      "INSERT INTO driver_state (id, flow_name, step_index, complete, pending_user_answer, scratch) " +
        "VALUES (1, 'implementation', 5, 0, NULL, '{}')",
    );
    await tx.exec("INSERT INTO pipeline_counters (id) VALUES (1)");
    await tx.exec(
      "INSERT INTO phases (name, status, skipped_reason, updated_at) " +
        "VALUES ('implementation', 'skipped', 'swept for fixture', ?)",
      [NOW],
    );
  });
}

async function insertBlocking(
  dir: string,
  opts: { id: string; status?: string; severity?: string },
): Promise<void> {
  await withStateTransaction(dir, NOW, async (tx) => {
    await tx.exec(
      "INSERT INTO findings (id, task_id, agent, iteration, phase, file, line_start, " +
        "line_end, severity, category, proposed_new_category, pattern_id, summary, " +
        "evidence_excerpt, suggested_fix, status, ref_rule_id, recorded_at) " +
        "VALUES (?, 't-2026-06-02-ovr', 'logic-reviewer', 1, 'implementation', " +
        "'src/x.ts', 10, 12, ?, 'correctness', NULL, NULL, 'claims a crash at runtime', " +
        "NULL, NULL, ?, NULL, ?)",
      [opts.id, opts.severity ?? "blocking", opts.status ?? "open", NOW],
    );
  });
}

async function countBlocking(dir: string, phase: string): Promise<number> {
  return withStateTransaction(dir, NOW, async (tx) => {
    const snap = await materializeAccessSnapshot(tx);
    return snap.findings.countBlocking({ phase });
  });
}

async function readRow(
  dir: string,
  id: string,
): Promise<{ status: string; severity: string; recorded_at: string } | null> {
  const row = await withStateTransaction(dir, NOW, (tx) =>
    tx.queryRow<{ status: string; severity: string; recorded_at: string }>(
      "SELECT status, severity, recorded_at FROM findings WHERE id = ?",
      [id],
    ),
  );
  return row ?? null;
}

describe("update_finding_status — live-blocking transition", () => {
  let dir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    dir = freshProject();
    openDb(dir);
  });
  afterEach(() => cleanup(dir));

  it("dropping the original to dismissed removes it from the live-blocking set", async () => {
    await seed(dir);
    await insertBlocking(dir, { id: "f-1" });
    assert.equal(await countBlocking(dir, "implementation"), 1);

    // Drive the override through the real BundleScratchTx mutator binding
    // (fsm.ts) → BundleOp → applier, exactly as a bundle Step would.
    await withStateTransaction(dir, NOW, async (tx) => {
      const { ctx, ops } = await buildStageContext(inMemoryState(dir), buildRegistry(), tx);
      ctx.tx.update_finding_status?.("f-1", { status: "dismissed" });
      await applyBundleOps(tx, ops);
    });

    // Revert the applier arm → the UPDATE no-ops, the row stays open, and
    // this stays 1 → reddens.
    assert.equal(await countBlocking(dir, "implementation"), 0);
    assert.equal((await readRow(dir, "f-1"))?.status, "dismissed");
  });

  it("downgrading severity below blocking also removes it from the live set, leaving status open", async () => {
    await seed(dir);
    await insertBlocking(dir, { id: "f-2" });

    await withStateTransaction(dir, NOW, (tx) =>
      applyBundleOps(tx, [{ op: "update_finding_status", id: "f-2", severity: "info" }]),
    );

    assert.equal(await countBlocking(dir, "implementation"), 0);
    const row = await readRow(dir, "f-2");
    assert.equal(row?.severity, "info");
    assert.equal(row?.status, "open", "a severity downgrade leaves status untouched");
  });

  it("re-asserting blocking/open keeps the finding live (the confirmed path)", async () => {
    await seed(dir);
    await insertBlocking(dir, { id: "f-3" });

    await withStateTransaction(dir, NOW, (tx) =>
      applyBundleOps(tx, [
        { op: "update_finding_status", id: "f-3", status: "open", severity: "blocking" },
      ]),
    );

    assert.equal(await countBlocking(dir, "implementation"), 1);
  });

  it("an empty patch (neither column) is a no-op and leaves the row unchanged", async () => {
    await seed(dir);
    await insertBlocking(dir, { id: "f-4" });
    const before = await readRow(dir, "f-4");

    await withStateTransaction(dir, NOW, (tx) =>
      applyBundleOps(tx, [{ op: "update_finding_status", id: "f-4" }]),
    );

    const after = await readRow(dir, "f-4");
    assert.deepEqual(after, before);
    assert.equal(await countBlocking(dir, "implementation"), 1);
  });
});

describe("update_finding_status — acceptance veto on a real commit", () => {
  let dir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    dir = freshProject();
    openDb(dir);
  });
  afterEach(() => cleanup(dir));

  it("a refuted (dismissed) override lets the accept commit; a confirmed one keeps inv008 blocking", async () => {
    await seed(dir);
    await insertBlocking(dir, { id: "f-impl-1" });

    // Confirmed: re-assert blocking → the accept is still vetoed by inv008.
    await withStateTransaction(dir, NOW, (tx) =>
      applyBundleOps(tx, [
        { op: "update_finding_status", id: "f-impl-1", status: "open", severity: "blocking" },
      ]),
    );
    await assert.rejects(
      withStateTransaction(dir, NOW, (tx) =>
        tx.exec("UPDATE pipeline_state SET verdict = 'accepted' WHERE id = 1"),
      ),
      (err: unknown) =>
        err instanceof KernelError &&
        err.code === "INVARIANT_VIOLATION" &&
        JSON.stringify(err.detail).includes("INV_008"),
    );
    assert.equal((await withStateTransaction(dir, NOW, (tx) => loadState(tx))).verdict, null);

    // Refuted: dismiss the original → live-blocking clears → the same accept
    // commit goes through. Revert the applier arm and the dismiss no-ops, so
    // the accept stays vetoed → this commit rejects → reddens.
    await withStateTransaction(dir, NOW, (tx) =>
      applyBundleOps(tx, [{ op: "update_finding_status", id: "f-impl-1", status: "dismissed" }]),
    );
    await withStateTransaction(dir, NOW, (tx) =>
      tx.exec("UPDATE pipeline_state SET verdict = 'accepted' WHERE id = 1"),
    );
    assert.equal(
      (await withStateTransaction(dir, NOW, (tx) => loadState(tx))).verdict,
      "accepted",
    );
  });
});

describe("update_finding_status — co-commit atomicity + replay idempotency", () => {
  let dir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    dir = freshProject();
    openDb(dir);
  });
  afterEach(() => cleanup(dir));

  it("rolls back with its tx — a throw after the override leaves the original live (co-commit)", async () => {
    await seed(dir);
    await insertBlocking(dir, { id: "f-atomic" });

    await assert.rejects(
      withStateTransaction(dir, NOW, async (tx) => {
        await applyBundleOps(tx, [
          { op: "update_finding_status", id: "f-atomic", status: "dismissed" },
        ]);
        // The override is buffered in the SAME tx as everything else this
        // tick; aborting the tick must un-apply it.
        throw new Error("abort the tick after the override");
      }),
      /abort the tick/,
    );

    // The dismiss did NOT survive the rollback — still a live blocker.
    assert.equal(await countBlocking(dir, "implementation"), 1);
    assert.equal((await readRow(dir, "f-atomic"))?.status, "open");
  });

  it("applying the same override twice is a no-op the second time (replay-safe)", async () => {
    await seed(dir);
    await insertBlocking(dir, { id: "f-idem" });

    const op: BundleOp = { op: "update_finding_status", id: "f-idem", severity: "info" };
    await withStateTransaction(dir, NOW, (tx) => applyBundleOps(tx, [op]));
    const afterFirst = await readRow(dir, "f-idem");
    await withStateTransaction(dir, NOW, (tx) => applyBundleOps(tx, [op]));
    const afterSecond = await readRow(dir, "f-idem");

    assert.deepEqual(afterSecond, afterFirst, "re-applying re-sets the same value");
    assert.equal(await countBlocking(dir, "implementation"), 0);
  });
});

// ============================================================================
// Minimal registry / state fixtures (the buildStageContext path needs both)
// ============================================================================

function buildRegistry(): Registry {
  const stubProvider: LLMProvider = {
    name: "stub",
    capabilities: { execution: "shuttle", idempotent_spawn: true, reports_usage: true },
    async spawn() {
      throw new Error("stub provider — spawn must not run");
    },
  };
  const bundle: Bundle = {
    name: "code-fixture",
    version: "0.0.1",
    description: "override fixture",
    phases: ["implementation"],
    default_flow: "impl",
    default_gate_policies: {} as Record<GateRole, PolicyName>,
    gate_roles: {},
    agents: [],
    stages: {},
    flows: { impl: ["x"] },
    hooks: [],
    invariants: [],
  };
  return {
    bundle,
    agents: new Map(),
    stages: new Map(),
    flows: new Map([["impl", ["x"]]]),
    hooks: [],
    invariants: [],
    mcp_clients: new Map(),
    providers: {
      resolve: () => stubProvider,
      all: [stubProvider],
      health_check_all: Promise.resolve([{ name: "stub", healthy: true }]),
    },
    policyFactories: new Map<PolicyName, () => Policy>(),
    vocabularies: buildVocabularies(bundle),
  };
}

function inMemoryState(dir: string): PipelineState {
  return {
    schema_version: "3.0.0",
    task_id: "t-2026-06-02-ovr",
    driver_state_id: DRIVER,
    project_dir: dir,
    bundle: "code-fixture",
    task: "seeded task",
    task_short: null,
    owner_id: null,
    status: "in_progress",
    verdict: null,
    started_at: NOW,
    ended_at: null,
    gate_policies: {} as Record<GateRole, PolicyName>,
    decisions: {},
    bundle_state: null,
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
    driver: {
      flow_name: "implementation",
      step_index: 5,
      complete: false,
      pending_user_answer: null,
      scratch: {},
    },
    phases: [
      {
        name: "implementation",
        status: "skipped",
        skipped_reason: "swept for fixture",
        phase_extension: null,
        updated_at: NOW,
      },
    ],
    gates: {},
    agent_verdicts: [],
    pending_agents: [],
    now: NOW,
  };
}
