import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  ZOMBIE_PENDING_MS,
  _resetInvariantsForTest,
  buildKernelSnapshots,
  inv001,
  inv002,
  inv003,
  inv004,
  inv007,
  inv008,
  inv010,
  inv011,
  inv012,
  inv013,
  inv014,
  inv015,
  invSchemaState,
  kernelInvariants,
  registerInvariant,
  runInvariants,
} from "../src/invariants.js";
import {
  KernelError,
  TransactionImpl,
  captureNow,
  closeDb,
  openDb,
  withStateTransaction,
} from "../src/state.js";
import type { Invariant, KernelSnapshots, Violation } from "../src/types/invariants.js";
import type { NowToken } from "../src/types/now.js";
import type { AgentRecord } from "../src/types/agent-result.js";
import type { IdempotencyKey, IdempotencyLedgerEntry } from "../src/types/idempotency.js";
import type {
  AgentVerdictRow,
  GateRole,
  GateRow,
  PendingAgentRow,
  PhaseRow,
} from "../src/types/row-types.js";
import type { PolicyName } from "../src/types/policy.js";
import type { BundleStateView } from "../src/types/state.js";

// Each test builds its `BundleStateView` from a baseline + overrides
// so individual cases stay focused on one rule. The baseline is a
// minimal "fresh task, nothing happened yet" snapshot.
function baseState(overrides: Partial<BundleStateView> = {}): BundleStateView {
  const now = "2026-05-28T12:00:00.000Z" as NowToken;
  const started = "2026-05-28T11:00:00.000Z" as NowToken;
  return {
    task_id: "t-2026-05-28-fixture",
    driver_state_id: "d-fixture",
    project_dir: "/tmp/fixture",
    bundle: "code",
    task: "build a thing",
    task_short: null,
    owner_id: null,
    status: "in_progress",
    verdict: null,
    started_at: started,
    ended_at: null,
    // GateRole is an open string union but the type-level Record
    // demands the three kernel-literal keys; empty objects cast at
    // the test boundary mirror what loadState does at the runtime
    // boundary.
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
    phases: [],
    gates: {},
    agent_verdicts: [],
    pending_agents: [],
    now,
    ...overrides,
  };
}

function emptySnapshots(): KernelSnapshots {
  return {};
}

function makePhase(overrides: Partial<PhaseRow>): PhaseRow {
  return {
    name: "planning",
    status: "pending",
    skipped_reason: null,
    phase_extension: null,
    updated_at: "2026-05-28T10:00:00.000Z",
    ...overrides,
  };
}

function makeGate(overrides: Partial<GateRow>): GateRow {
  return {
    name: "gate-plan",
    status: "pending",
    decided_by: "human",
    feedback: null,
    decided_at: null,
    ...overrides,
  };
}

function makePending(overrides: Partial<PendingAgentRow>): PendingAgentRow {
  return {
    agent_run_id: "ar-00000000-0000-0000-0000-000000000001",
    agent: "planner",
    phase: "planning",
    model: null,
    started_at: "2026-05-28T11:30:00.000Z" as NowToken,
    ...overrides,
  };
}

function makeVerdict(overrides: Partial<AgentVerdictRow>): AgentVerdictRow {
  return {
    phase: "planning",
    agent: "reviewer",
    iteration: 1,
    verdict: "APPROVE",
    summary_line: null,
    blocking_issues: 0,
    warn_issues: 0,
    info_issues: 0,
    categories_seen: [],
    recorded_at: "2026-05-28T11:45:00.000Z",
    ...overrides,
  };
}

function makeAgentRecord(overrides: Partial<AgentRecord>): AgentRecord {
  return {
    id: 1,
    agent_run_id: "ar-00000000-0000-0000-0000-000000000001",
    agent: "planner",
    phase: "planning",
    model: null,
    output_kind: "nonreview",
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    recorded_at: "2026-05-28T11:45:00.000Z",
    ...overrides,
  };
}

function makeLedgerEntry(
  overrides: Partial<IdempotencyLedgerEntry>,
): IdempotencyLedgerEntry {
  return {
    key: "agent-result:ar-00000000-0000-0000-0000-000000000001" as IdempotencyKey,
    first_seen_ts: "2026-05-28T11:45:00.000Z",
    last_seen_ts: "2026-05-28T11:45:00.000Z",
    response_blob: null,
    hook_results_json: null,
    ...overrides,
  };
}

// ============================================================================
// Schema-meta invariant
// ============================================================================

describe("invSchemaState", () => {
  it("returns null for a clean fixture", () => {
    assert.equal(invSchemaState(baseState(), emptySnapshots()), null);
  });

  it("detects empty bundle name", () => {
    const v = invSchemaState(baseState({ bundle: "" }), emptySnapshots());
    assert.ok(v !== null);
    assert.equal(v.code, "INV_SCHEMA_STATE");
  });

  it("detects empty task name", () => {
    const v = invSchemaState(baseState({ task: "" }), emptySnapshots());
    assert.ok(v !== null);
    assert.equal(v.code, "INV_SCHEMA_STATE");
  });

  it("detects empty driver_state_id", () => {
    const v = invSchemaState(
      baseState({ driver_state_id: "" }),
      emptySnapshots(),
    );
    assert.ok(v !== null);
    assert.equal(v.code, "INV_SCHEMA_STATE");
  });

  it("detects malformed started_at", () => {
    const v = invSchemaState(
      baseState({ started_at: "not-iso" as NowToken }),
      emptySnapshots(),
    );
    assert.ok(v !== null);
    assert.equal(v.code, "INV_SCHEMA_STATE");
  });

  it("detects malformed ended_at when present", () => {
    const v = invSchemaState(
      baseState({ ended_at: "not-iso" as NowToken }),
      emptySnapshots(),
    );
    assert.ok(v !== null);
    assert.equal(v.code, "INV_SCHEMA_STATE");
  });
});

// ============================================================================
// State-shape invariants
// ============================================================================

describe("inv001", () => {
  it("returns null when complexity is absent", () => {
    const state = baseState({
      phases: [makePhase({ name: "context", status: "completed" })],
    });
    assert.equal(inv001(state, emptySnapshots()), null);
  });

  it("returns null when no phase is completed", () => {
    const state = baseState({
      decisions: { complexity: "medium" },
      phases: [makePhase({ status: "in_progress" })],
    });
    assert.equal(inv001(state, emptySnapshots()), null);
  });

  it("fires when complexity=medium + completed phase + agents_count=0", () => {
    const state = baseState({
      decisions: { complexity: "medium" },
      agents_count: 0,
      phases: [makePhase({ name: "context", status: "completed" })],
    });
    const v = inv001(state, emptySnapshots());
    assert.ok(v !== null);
    assert.equal(v.code, "INV_001");
  });

  it("returns null when agents_count > 0", () => {
    const state = baseState({
      decisions: { complexity: "complex" },
      agents_count: 1,
      phases: [makePhase({ name: "context", status: "completed" })],
    });
    assert.equal(inv001(state, emptySnapshots()), null);
  });
});

describe("inv002", () => {
  it("returns null when no completed phase", () => {
    const state = baseState({ phases: [makePhase({ status: "in_progress" })] });
    assert.equal(inv002(state, { agent_records: [] }), null);
  });

  it("fires when completed phase has no agent_records", () => {
    const state = baseState({
      phases: [makePhase({ name: "context", status: "completed" })],
    });
    const v = inv002(state, { agent_records: [] });
    assert.ok(v !== null);
    assert.equal(v.code, "INV_002");
  });

  it("returns null when phase_extension.allow_empty is true", () => {
    const state = baseState({
      phases: [
        makePhase({
          name: "context",
          status: "completed",
          phase_extension: { allow_empty: true },
        }),
      ],
    });
    assert.equal(inv002(state, { agent_records: [] }), null);
  });

  it("returns null when agent_records covers the phase", () => {
    const state = baseState({
      phases: [makePhase({ name: "context", status: "completed" })],
    });
    assert.equal(
      inv002(state, {
        agent_records: [makeAgentRecord({ phase: "context" })],
      }),
      null,
    );
  });
});

describe("inv003", () => {
  it("returns null for a non-skipped phase", () => {
    const state = baseState({ phases: [makePhase({ status: "completed" })] });
    assert.equal(inv003(state, emptySnapshots()), null);
  });

  it("fires when skipped phase has empty skipped_reason", () => {
    const state = baseState({
      phases: [makePhase({ status: "skipped", skipped_reason: null })],
    });
    const v = inv003(state, emptySnapshots());
    assert.ok(v !== null);
    assert.equal(v.code, "INV_003");
  });

  it("returns null when skipped_reason is populated", () => {
    const state = baseState({
      phases: [
        makePhase({ status: "skipped", skipped_reason: "not relevant" }),
      ],
    });
    assert.equal(inv003(state, emptySnapshots()), null);
  });
});

describe("inv004", () => {
  it("returns null when verdict count <= agents_count", () => {
    const state = baseState({
      agents_count: 3,
      agent_verdicts: [makeVerdict({}), makeVerdict({ iteration: 2 })],
    });
    assert.equal(inv004(state, emptySnapshots()), null);
  });

  it("fires when verdict count exceeds agents_count", () => {
    const state = baseState({
      agents_count: 1,
      agent_verdicts: [makeVerdict({}), makeVerdict({ iteration: 2 })],
    });
    const v = inv004(state, emptySnapshots());
    assert.ok(v !== null);
    assert.equal(v.code, "INV_004");
  });
});

describe("inv007", () => {
  it("returns null when verdict is null", () => {
    const state = baseState({
      verdict: null,
      phases: [makePhase({ status: "in_progress" })],
    });
    assert.equal(inv007(state, emptySnapshots()), null);
  });

  it("returns null when verdict set + every phase terminal", () => {
    const state = baseState({
      verdict: "accepted",
      phases: [
        makePhase({ name: "context", status: "completed" }),
        makePhase({ name: "planning", status: "skipped", skipped_reason: "no-op" }),
      ],
    });
    assert.equal(inv007(state, emptySnapshots()), null);
  });

  it("fires when verdict set but a phase is still in_progress", () => {
    const state = baseState({
      verdict: "accepted",
      phases: [
        makePhase({ name: "context", status: "completed" }),
        makePhase({ name: "planning", status: "in_progress" }),
      ],
    });
    const v = inv007(state, emptySnapshots());
    assert.ok(v !== null);
    assert.equal(v.code, "INV_007");
  });
});

describe("inv008", () => {
  // No findings collection on BundleStateView / KernelSnapshots yet —
  // the body is a forward-compatible no-op until a schema registry
  // and findings snapshot land. Only the clean-fixture branch is
  // testable; documenting the gap so a future session knows to add
  // the violating-fixture pair when the dependencies arrive.
  it("returns null on any state (no schema registry available yet)", () => {
    assert.equal(inv008(baseState(), emptySnapshots()), null);
  });
});

describe("inv010", () => {
  it("returns null for known phase statuses", () => {
    const state = baseState({
      phases: [
        makePhase({ name: "a", status: "pending" }),
        makePhase({ name: "b", status: "in_progress" }),
        makePhase({ name: "c", status: "completed" }),
        makePhase({
          name: "d",
          status: "skipped",
          skipped_reason: "no-op",
        }),
      ],
    });
    assert.equal(inv010(state, emptySnapshots()), null);
  });

  it("fires when a phase has an unknown status", () => {
    const state = baseState({
      phases: [
        makePhase({
          name: "weird",
          // Type-cast through unknown so the test fixture can model
          // the corruption case (a future migration relaxing the
          // CHECK constraint) without inviting `any`.
          status: "frobbed" as PhaseRow["status"],
        }),
      ],
    });
    const v = inv010(state, emptySnapshots());
    assert.ok(v !== null);
    assert.equal(v.code, "INV_010");
  });
});

describe("inv011", () => {
  it("returns null when prereq is completed", () => {
    const state = baseState({
      phases: [
        makePhase({ name: "context", status: "completed" }),
        makePhase({
          name: "planning",
          status: "in_progress",
          phase_extension: { prereqs: ["context"] },
        }),
      ],
    });
    assert.equal(inv011(state, emptySnapshots()), null);
  });

  it("fires when a phase leaves pending while prereq is still pending", () => {
    const state = baseState({
      phases: [
        makePhase({ name: "context", status: "pending" }),
        makePhase({
          name: "planning",
          status: "in_progress",
          phase_extension: { prereqs: ["context"] },
        }),
      ],
    });
    const v = inv011(state, emptySnapshots());
    assert.ok(v !== null);
    assert.equal(v.code, "INV_011");
  });

  it("returns null when phase has no prereqs declared", () => {
    const state = baseState({
      phases: [makePhase({ name: "context", status: "in_progress" })],
    });
    assert.equal(inv011(state, emptySnapshots()), null);
  });

  it("skips a prereq whose phase is not in the phase map", () => {
    // Bundles may declare prereqs that aren't tracked as separate
    // phase rows (e.g., references to bundle-state preconditions
    // surfaced via phase_extension). The invariant should not
    // fire on a missing entry — only on prereqs whose tracked
    // status is non-terminal.
    const state = baseState({
      phases: [
        makePhase({
          name: "planning",
          status: "in_progress",
          phase_extension: { prereqs: ["nonexistent-phase"] },
        }),
      ],
    });
    assert.equal(inv011(state, emptySnapshots()), null);
  });

  it("skips non-string entries in the prereqs array", () => {
    // Phase extension is `Record<string, unknown>` — a malformed
    // entry should not crash the invariant; only string prereq
    // names participate.
    const state = baseState({
      phases: [
        makePhase({ name: "context", status: "completed" }),
        makePhase({
          name: "planning",
          status: "in_progress",
          phase_extension: { prereqs: [42, "context"] },
        }),
      ],
    });
    assert.equal(inv011(state, emptySnapshots()), null);
  });
});

describe("inv012", () => {
  it("returns null when no pending_agents rows", () => {
    const state = baseState({
      phases: [makePhase({ name: "context", status: "completed" })],
    });
    assert.equal(inv012(state, emptySnapshots()), null);
  });

  it("fires when completed phase has a lingering pending row", () => {
    const state = baseState({
      phases: [makePhase({ name: "context", status: "completed" })],
      pending_agents: [makePending({ phase: "context" })],
    });
    const v = inv012(state, emptySnapshots());
    assert.ok(v !== null);
    assert.equal(v.code, "INV_012");
  });

  it("returns null when pending row is for a non-terminal phase", () => {
    const state = baseState({
      phases: [makePhase({ name: "planning", status: "in_progress" })],
      pending_agents: [makePending({ phase: "planning" })],
    });
    assert.equal(inv012(state, emptySnapshots()), null);
  });
});

// ============================================================================
// Ledger-consistency invariants
// ============================================================================

describe("inv013", () => {
  it("returns null on a clean ledger", () => {
    const ledger: IdempotencyLedgerEntry[] = [
      makeLedgerEntry({ key: "agent-result:ar-1" as IdempotencyKey }),
      makeLedgerEntry({ key: "task-create:t-2026-05-28-x" as IdempotencyKey }),
    ];
    assert.equal(inv013(baseState(), { ledger }), null);
  });

  it("fires on a malformed key", () => {
    const ledger: IdempotencyLedgerEntry[] = [
      makeLedgerEntry({ key: "unknown-op:abc" as IdempotencyKey }),
    ];
    const v = inv013(baseState(), { ledger });
    assert.ok(v !== null);
    assert.equal(v.code, "INV_013");
  });

  it("fires on a key missing the suffix", () => {
    const ledger: IdempotencyLedgerEntry[] = [
      makeLedgerEntry({ key: "agent-result:" as IdempotencyKey }),
    ];
    const v = inv013(baseState(), { ledger });
    assert.ok(v !== null);
    assert.equal(v.code, "INV_013");
  });
});

describe("inv014", () => {
  it("returns null when no agent-result rows", () => {
    const ledger: IdempotencyLedgerEntry[] = [
      makeLedgerEntry({
        key: "task-create:t-2026-05-28-x" as IdempotencyKey,
        response_blob: "{}",
      }),
    ];
    assert.equal(inv014(baseState(), { ledger }), null);
  });

  it("returns null when agent-result row has null response_blob", () => {
    const ledger: IdempotencyLedgerEntry[] = [
      makeLedgerEntry({
        key: "agent-result:ar-orphan" as IdempotencyKey,
        response_blob: null,
      }),
    ];
    const state = baseState({
      pending_agents: [makePending({ agent_run_id: "ar-orphan" })],
    });
    assert.equal(inv014(state, { ledger }), null);
  });

  it("fires when committed agent-result coincides with a pending row", () => {
    const ledger: IdempotencyLedgerEntry[] = [
      makeLedgerEntry({
        key: "agent-result:ar-collide" as IdempotencyKey,
        response_blob: "{}",
      }),
    ];
    const state = baseState({
      pending_agents: [makePending({ agent_run_id: "ar-collide" })],
    });
    const v = inv014(state, { ledger });
    assert.ok(v !== null);
    assert.equal(v.code, "INV_014");
  });
});

describe("inv015", () => {
  it("returns null when no pending rows", () => {
    assert.equal(inv015(baseState(), { ledger: [] }), null);
  });

  it("returns null when pending row is younger than threshold", () => {
    const now = "2026-05-28T12:00:00.000Z" as NowToken;
    const started = "2026-05-28T11:59:00.000Z" as NowToken; // 1 minute ago
    const state = baseState({
      now,
      pending_agents: [makePending({ started_at: started })],
    });
    assert.equal(inv015(state, { ledger: [] }), null);
  });

  it("fires when pending row older than threshold with no provider-call ledger", () => {
    const now = "2026-05-28T12:00:00.000Z" as NowToken;
    // ZOMBIE_PENDING_MS = 50 min. Push started_at 60 min into the past.
    const startedEpoch = Date.parse(now) - ZOMBIE_PENDING_MS - 10 * 60 * 1000;
    const started = new Date(startedEpoch).toISOString() as NowToken; // allow-ambient-clock: derives from a parsed NowToken string only; never reads the host clock
    const state = baseState({
      now,
      pending_agents: [makePending({ started_at: started, agent_run_id: "ar-zombie" })],
    });
    const v = inv015(state, { ledger: [] });
    assert.ok(v !== null);
    assert.equal(v.code, "INV_015");
  });

  it("returns null when a provider-call ledger entry covers the stale pending row", () => {
    const now = "2026-05-28T12:00:00.000Z" as NowToken;
    const startedEpoch = Date.parse(now) - ZOMBIE_PENDING_MS - 10 * 60 * 1000;
    const started = new Date(startedEpoch).toISOString() as NowToken; // allow-ambient-clock: derives from a parsed NowToken string only; never reads the host clock
    const ledger: IdempotencyLedgerEntry[] = [
      makeLedgerEntry({
        key: "provider-call:ar-zombie" as IdempotencyKey,
        response_blob: "{}",
      }),
    ];
    const state = baseState({
      now,
      pending_agents: [makePending({ started_at: started, agent_run_id: "ar-zombie" })],
    });
    assert.equal(inv015(state, { ledger }), null);
  });
});

// ============================================================================
// buildKernelSnapshots
// ============================================================================

describe("buildKernelSnapshots", () => {
  // The snapshot materializer is exercised by `runInvariants` itself,
  // but we want a direct unit test that:
  //   - declared "agent_records" path → SELECT runs
  //   - declared "kernel_idempotency_ledger" path → SELECT runs
  //   - declared no snapshot path → both stay undefined
  it("materializes only the snapshots whose paths are declared", async () => {
    const captured: string[] = [];
    const fakeTx = {
      now: "2026-05-28T12:00:00.000Z" as NowToken,
      audit_buffer: [] as Record<string, unknown>[],
      exec: async () => {},
      queryRow: async () => null,
      queryAll: async (sql: string) => {
        captured.push(sql);
        return [];
      },
    };

    const phasesOnly: Invariant = Object.assign(
      (_s: BundleStateView, _k: KernelSnapshots): Violation | null => null,
      { reads: ["phases"] },
    );
    const ledgerOnly: Invariant = Object.assign(
      (_s: BundleStateView, _k: KernelSnapshots): Violation | null => null,
      { reads: ["kernel_idempotency_ledger"] },
    );
    const agentRecordsOnly: Invariant = Object.assign(
      (_s: BundleStateView, _k: KernelSnapshots): Violation | null => null,
      { reads: ["agent_records"] },
    );

    // Only phases declared → no SELECTs.
    captured.length = 0;
    const snap1 = await buildKernelSnapshots(fakeTx, [phasesOnly]);
    assert.equal(snap1.agent_records, undefined);
    assert.equal(snap1.ledger, undefined);
    assert.equal(captured.length, 0);

    // Ledger declared → ledger SELECT runs.
    captured.length = 0;
    const snap2 = await buildKernelSnapshots(fakeTx, [ledgerOnly]);
    assert.equal(snap2.agent_records, undefined);
    assert.ok(snap2.ledger !== undefined);
    assert.equal(captured.length, 1);
    assert.match(captured[0] ?? "", /kernel_idempotency_ledger/);

    // Both declared → both SELECTs run.
    captured.length = 0;
    const snap3 = await buildKernelSnapshots(fakeTx, [
      ledgerOnly,
      agentRecordsOnly,
    ]);
    assert.ok(snap3.agent_records !== undefined);
    assert.ok(snap3.ledger !== undefined);
    assert.equal(captured.length, 2);
  });

  it("'*' reads materialize every snapshot", async () => {
    const captured: string[] = [];
    const fakeTx = {
      now: "2026-05-28T12:00:00.000Z" as NowToken,
      audit_buffer: [] as Record<string, unknown>[],
      exec: async () => {},
      queryRow: async () => null,
      queryAll: async (sql: string) => {
        captured.push(sql);
        return [];
      },
    };
    const wildcard: Invariant = Object.assign(
      (_s: BundleStateView, _k: KernelSnapshots): Violation | null => null,
      { reads: ["*"] },
    );
    const snap = await buildKernelSnapshots(fakeTx, [wildcard]);
    assert.ok(snap.agent_records !== undefined);
    assert.ok(snap.ledger !== undefined);
    assert.equal(captured.length, 2);
  });
});

// ============================================================================
// kernelInvariants set
// ============================================================================

describe("kernelInvariants set", () => {
  it("ships exactly the 13 documented invariants by code", () => {
    // Drive each invariant against a fixture that violates every
    // rule simultaneously, then collect the codes that fire so we
    // verify the wired-up identity of every entry — not just that
    // there are 13 of them.
    const state = baseState({
      bundle: "", // invSchemaState fires
      decisions: { complexity: "medium" }, // inv001
      agents_count: 0,
      verdict: "accepted", // inv007
      agent_verdicts: [
        makeVerdict({}),
        makeVerdict({ iteration: 2 }), // inv004 (count=2 > agents_count=0)
      ],
      phases: [
        makePhase({ name: "context", status: "completed" }), // inv001/inv002
        makePhase({ name: "validation", status: "skipped" }), // inv003 (no reason)
        makePhase({
          name: "planning",
          status: "in_progress",
          phase_extension: { prereqs: ["unmet"] },
        }), // inv011 (prereq missing → never settles), inv007 (unsettled)
        makePhase({ name: "unmet", status: "pending" }),
        makePhase({
          name: "implementation",
          status: "completed",
        }), // inv002 + inv012 (pending row attached)
      ],
      pending_agents: [
        makePending({
          phase: "implementation",
          agent_run_id: "ar-stuck",
          started_at: "2020-01-01T00:00:00.000Z" as NowToken, // very old → inv015
        }),
      ],
    });
    // Force an INV_010 hit by adding a corrupted phase status.
    const corruptedState = baseState({
      ...state,
      phases: [
        ...state.phases,
        makePhase({ name: "weird", status: "frobbed" as PhaseRow["status"] }),
      ],
    });
    const ledger: IdempotencyLedgerEntry[] = [
      makeLedgerEntry({
        key: "garbage-key:abc" as IdempotencyKey, // inv013
      }),
      makeLedgerEntry({
        key: "agent-result:ar-stuck" as IdempotencyKey,
        response_blob: "{}", // inv014 collision
      }),
    ];
    const snapshots: KernelSnapshots = { agent_records: [], ledger };
    const fired = new Set<string>();
    for (const inv of kernelInvariants) {
      const v = inv(corruptedState, snapshots);
      if (v !== null) fired.add(v.code);
    }
    // The full set of kernel-generic codes — INV_008 stays out
    // because the findings collection is not yet on the
    // snapshot surface (forward-compat stub).
    const expected = new Set([
      "INV_SCHEMA_STATE",
      "INV_001",
      "INV_002",
      "INV_003",
      "INV_004",
      "INV_007",
      "INV_010",
      "INV_011",
      "INV_012",
      "INV_013",
      "INV_014",
      "INV_015",
    ]);
    for (const code of expected) {
      assert.ok(fired.has(code), `expected ${code} to fire on the corrupted fixture (got: ${[...fired].join(", ")})`);
    }
    assert.equal(kernelInvariants.length, 13);
    for (const inv of kernelInvariants) {
      assert.ok(Array.isArray(inv.reads), "every invariant declares reads");
      assert.ok(inv.reads.length > 0, "reads is non-empty");
    }
  });
});

// ============================================================================
// runInvariants — end-to-end on a real SQLite tx
// ============================================================================

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "loom-invariants-"));
}

function teardownProject(projectDir: string): void {
  try {
    closeDb(projectDir);
  } catch {
    /* may already be closed */
  }
  rmSync(projectDir, { recursive: true, force: true });
}

async function seedPipelineRow(projectDir: string): Promise<void> {
  const now = captureNow();
  await withStateTransaction(projectDir, now, async (tx) => {
    await tx.exec(
      "INSERT INTO pipeline_state (id, schema_version, project_dir, bundle, " +
        "task, driver_state_id, status, started_at) " +
        "VALUES (1, ?, ?, ?, ?, ?, ?, ?)",
      [
        "3.0.0",
        projectDir,
        "code",
        "build a thing",
        "d-fixture",
        "in_progress",
        now,
      ],
    );
    await tx.exec(
      "INSERT INTO driver_state (id, flow_name, step_index, complete) " +
        "VALUES (1, 'simple', 0, 0)",
    );
    await tx.exec("INSERT INTO pipeline_counters (id) VALUES (1)");
  });
}

describe("runInvariants — real-DB integration", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => {
    _resetInvariantsForTest();
    teardownProject(projectDir);
  });

  it("returns [] on a clean baseline (every kernel invariant passes)", async () => {
    await seedPipelineRow(projectDir);
    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      const v = await runInvariants(tx);
      assert.deepEqual(v, []);
    });
  });

  it("materializes snapshots from real DB rows (INV_014 trips on a colliding write)", async () => {
    await seedPipelineRow(projectDir);

    // Seed a real agent_record + ledger row that would collide
    // with a pending_agents entry — this combination trips
    // INV_014 (agent-result ledger with non-null response_blob ⇒
    // no pending row of the same agent_run_id). Wrap in
    // assert.rejects since invariants run at commit and roll the
    // whole batch back.
    const seedNow = captureNow();
    await assert.rejects(
      withStateTransaction(projectDir, seedNow, async (tx) => {
        await tx.exec(
          "INSERT INTO phases (name, status, updated_at) VALUES (?, ?, ?)",
          ["planning", "in_progress", seedNow],
        );
        await tx.exec(
          "INSERT INTO agent_records (phase, agent, agent_run_id, output_kind, recorded_at) " +
            "VALUES (?, ?, ?, ?, ?)",
          ["planning", "planner", "ar-collide-001", "nonreview", seedNow],
        );
        await tx.exec(
          "INSERT INTO pending_agents (agent_run_id, agent, phase, started_at) " +
            "VALUES (?, ?, ?, ?)",
          ["ar-collide-001", "planner", "planning", seedNow],
        );
        await tx.exec(
          "INSERT INTO kernel_idempotency_ledger " +
            "(key, first_seen_ts, last_seen_ts, response_blob, driver_state_id, " +
            "now_token, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [
            "agent-result:ar-collide-001",
            seedNow,
            seedNow,
            "{}",
            "d-fixture",
            seedNow,
            seedNow,
          ],
        );
      }),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "INVARIANT_VIOLATION");
        const detail = (err as KernelError).detail;
        assert.ok(detail !== undefined);
        const violations = detail["violations"] as Array<{ code: string }>;
        assert.ok(
          violations.some((v) => v.code === "INV_014"),
          `INV_014 should be among violations, got: ${violations.map((v) => v.code).join(", ")}`,
        );
        return true;
      },
    );

    // After rollback the colliding state must not persist.
    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      const row = await tx.queryRow<{ c: number }>(
        "SELECT COUNT(*) AS c FROM kernel_idempotency_ledger",
      );
      assert.equal(Number(row?.c), 0, "seed tx should have rolled back on INV_014");
    });
  });

  it("a registered additional invariant runs alongside the kernel set", async () => {
    await seedPipelineRow(projectDir);

    let observedNow: string | null = null;
    let calls = 0;
    const probe: Invariant = Object.assign(
      (state: BundleStateView, _snapshots: KernelSnapshots): Violation | null => {
        calls += 1;
        observedNow = state.now;
        return null;
      },
      { reads: ["phases"] },
    );
    registerInvariant(probe);

    // withStateTransaction itself calls runInvariants at commit, so
    // the probe runs exactly once even when the body is a no-op.
    const now = captureNow();
    await withStateTransaction(projectDir, now, async () => {
      /* no-op body; commit runs invariants */
    });
    assert.equal(calls, 1);
    assert.equal(observedNow, now, "probe should observe the tx's NowToken");
  });

  it("registered invariant that returns a violation rolls back the tx", async () => {
    await seedPipelineRow(projectDir);
    const probe: Invariant = Object.assign(
      (_state: BundleStateView, _snapshots: KernelSnapshots): Violation | null => ({
        code: "INV_TEST_ROLLBACK",
        message: "deliberate violation",
      }),
      { reads: ["phases"] },
    );
    registerInvariant(probe);

    await assert.rejects(
      withStateTransaction(projectDir, captureNow(), async (tx) => {
        await tx.exec(
          "UPDATE pipeline_state SET task_short = ? WHERE id = 1",
          ["should-not-stick"],
        );
      }),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "INVARIANT_VIOLATION");
        return true;
      },
    );

    // Unregister the probe BEFORE the verification tx — otherwise
    // the read-only commit also trips the probe and the verifier
    // never reaches its assertion.
    _resetInvariantsForTest();
    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      const row = await tx.queryRow<{ task_short: string | null }>(
        "SELECT task_short FROM pipeline_state WHERE id = 1",
      );
      assert.equal(row?.task_short, null, "the attempted write must not persist");
    });
  });

  it("runs kernel invariants first, then registered ones in registration order", async () => {
    await seedPipelineRow(projectDir);
    const calls: string[] = [];
    const probeA: Invariant = Object.assign(
      (_state: BundleStateView, _snapshots: KernelSnapshots): Violation | null => {
        calls.push("A");
        return null;
      },
      { reads: ["phases"] },
    );
    const probeB: Invariant = Object.assign(
      (_state: BundleStateView, _snapshots: KernelSnapshots): Violation | null => {
        calls.push("B");
        return null;
      },
      { reads: ["phases"] },
    );
    registerInvariant(probeA);
    registerInvariant(probeB);

    await withStateTransaction(projectDir, captureNow(), async () => {
      /* commit triggers runInvariants */
    });
    // Each probe runs once per commit; registration order is
    // preserved (A before B). Kernel invariants ran before the
    // probes but we don't assert their identities here — that's
    // the kernelInvariants set test's job.
    assert.deepEqual(calls, ["A", "B"]);
  });

  it("_resetInvariantsForTest clears registered invariants", async () => {
    await seedPipelineRow(projectDir);
    let calls = 0;
    const probe: Invariant = Object.assign(
      (_state: BundleStateView, _snapshots: KernelSnapshots): Violation | null => {
        calls += 1;
        return null;
      },
      { reads: ["phases"] },
    );
    registerInvariant(probe);
    _resetInvariantsForTest();

    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      await runInvariants(tx);
    });
    assert.equal(calls, 0, "probe should not have run after reset");
  });
});

// ============================================================================
// Replay determinism — end-to-end via runInvariants
// ============================================================================

describe("runInvariants — replay determinism", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => {
    _resetInvariantsForTest();
    teardownProject(projectDir);
  });

  it("N invocations on the same state + NowToken return byte-equal Violation[]", async () => {
    await seedPipelineRow(projectDir);

    // Persist a violation-fixture by writing directly to the
    // underlying DB (bypassing withStateTransaction's commit-time
    // invariant check). The fixture trips INV_003 (skipped phase
    // with null skipped_reason) — what we want is N identical
    // runs of runInvariants over that persistent state.
    const seedNow = captureNow();
    {
      const db = openDb(projectDir);
      db.prepare(
        "INSERT INTO phases (name, status, skipped_reason, updated_at) VALUES (?, ?, ?, ?)",
      ).run("planning", "skipped", null, seedNow);
    }

    // Replay determinism is a property of the pure-function chain
    // (loadState + narrow + snapshot + map). To exercise it
    // without the wrapper's commit-time throw, run runInvariants
    // directly on a manually-opened, rolled-back tx so the same
    // persistent state is read N times.
    const replayNow = captureNow();
    const db = openDb(projectDir);

    db.exec("BEGIN");
    let reference;
    try {
      const tx = new TransactionImpl(db, replayNow);
      reference = await runInvariants(tx);
    } finally {
      db.exec("ROLLBACK");
    }
    assert.ok(
      reference.some((v) => v.code === "INV_003"),
      `fixture should trip INV_003, got: ${reference.map((v) => v.code).join(", ")}`,
    );

    const N = 50;
    for (let i = 0; i < N; i++) {
      db.exec("BEGIN");
      let round;
      try {
        const tx = new TransactionImpl(db, replayNow);
        round = await runInvariants(tx);
      } finally {
        db.exec("ROLLBACK");
      }
      assert.deepEqual(round, reference, `iteration ${i} diverged from reference`);
    }
  });
});
