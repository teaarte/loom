import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  DEFAULT_SPAWN_DUPLICATE_WINDOW_MS,
  bypassMarkerGuard,
  ownerCheckGuard,
  phaseTransitionGuard,
  spawnGuard,
} from "../src/guards.js";
import {
  KernelError,
  captureNow,
  closeDb,
  withStateTransaction,
} from "../src/state.js";
import {
  _resetInvariantsForTest,
} from "../src/invariants.js";
import type { NowToken } from "../src/types/now.js";

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "loom-guards-"));
}

function cleanup(projectDir: string): void {
  try {
    closeDb(projectDir);
  } catch {
    /* may have already closed */
  }
  rmSync(projectDir, { recursive: true, force: true });
}

async function seedPipelineState(
  projectDir: string,
  ownerId: string | null,
): Promise<NowToken> {
  // SeedBaseline mirrors the state-core baseline so loadState succeeds when
  // ownerCheckGuard reads the row. Invariants run on commit; the
  // seed values are chosen to pass the kernel set (no completed
  // phases, no decisions.complexity, etc.).
  const now = captureNow();
  await withStateTransaction(projectDir, now, async (tx) => {
    await tx.exec(
      "INSERT INTO pipeline_state (id, schema_version, project_dir, bundle, " +
        "task, driver_state_id, owner_id, status, started_at) " +
        "VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "3.0.0",
        projectDir,
        "code",
        "build a thing",
        "d-fixture",
        ownerId,
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
  return now;
}

// ============================================================================
// SpawnGuard
// ============================================================================

describe("spawnGuard", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => {
    _resetInvariantsForTest();
    cleanup(projectDir);
  });

  it("allows a spawn with no prior pending_agents row", async () => {
    await seedPipelineState(projectDir, null);
    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      await spawnGuard(tx, "planner", "planning");
    });
  });

  it("refuses a duplicate spawn within the window", async () => {
    await seedPipelineState(projectDir, null);
    const seedNow = captureNow();
    await withStateTransaction(projectDir, seedNow, async (tx) => {
      await tx.exec(
        "INSERT INTO pending_agents (agent_run_id, agent, phase, started_at) " +
          "VALUES (?, ?, ?, ?)",
        ["ar-existing-001", "planner", "planning", seedNow],
      );
    });
    await assert.rejects(
      withStateTransaction(projectDir, captureNow(), async (tx) => {
        await spawnGuard(tx, "planner", "planning");
      }),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "DUPLICATE_SPAWN");
        return true;
      },
    );
  });

  it("allows a duplicate spawn outside the window", async () => {
    await seedPipelineState(projectDir, null);
    // Insert a pending row stamped well outside the duplicate window.
    const seedNow = captureNow();
    const oldEpoch = Date.parse(seedNow) - 10 * 60 * 1000; // 10 min ago
    const oldStamp = new Date(oldEpoch).toISOString() as NowToken; // allow-ambient-clock: derives from a parsed NowToken string only; never reads the host clock
    await withStateTransaction(projectDir, seedNow, async (tx) => {
      await tx.exec(
        "INSERT INTO pending_agents (agent_run_id, agent, phase, started_at) " +
          "VALUES (?, ?, ?, ?)",
        ["ar-stale-001", "planner", "planning", oldStamp],
      );
    });
    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      await spawnGuard(tx, "planner", "planning", {
        duplicate_window_ms: 5 * 60 * 1000,
      });
    });
  });

  it("fanout-aware variant: same agent name with a different agent_run_id is not a duplicate", async () => {
    await seedPipelineState(projectDir, null);
    const seedNow = captureNow();
    await withStateTransaction(projectDir, seedNow, async (tx) => {
      await tx.exec(
        "INSERT INTO pending_agents (agent_run_id, agent, phase, started_at) " +
          "VALUES (?, ?, ?, ?)",
        ["ar-sibling-A", "reviewer", "planning", seedNow],
      );
    });
    // A sibling launch carrying its own agent_run_id should pass.
    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      await spawnGuard(tx, "reviewer", "planning", {
        fanout_agent_run_id: "ar-sibling-B",
      });
    });
  });

  it("uses the documented default window when none supplied", () => {
    // Sanity check: the default constant matches the 5-minute number
    // the rule talks about.
    assert.equal(DEFAULT_SPAWN_DUPLICATE_WINDOW_MS, 5 * 60 * 1000);
  });
});

// ============================================================================
// PhaseTransitionGuard
// ============================================================================

describe("phaseTransitionGuard", () => {
  // Synthetic tx — the guard itself does not touch the DB.
  const fakeTx = {
    now: "2026-05-28T12:00:00.000Z" as NowToken,
    audit_buffer: [] as Record<string, unknown>[],
    exec: async () => {},
    queryRow: async () => null,
    queryAll: async () => [],
  };

  it("allows pending → in_progress", () => {
    phaseTransitionGuard(fakeTx, "planning", "pending", "in_progress");
  });

  it("allows in_progress → completed", () => {
    phaseTransitionGuard(fakeTx, "planning", "in_progress", "completed");
  });

  it("allows completed → skipped (terminal → terminal)", () => {
    // Both terminal — same-class re-stamping is permissible.
    phaseTransitionGuard(fakeTx, "planning", "completed", "skipped");
  });

  it("refuses completed → in_progress", () => {
    assert.throws(
      () =>
        phaseTransitionGuard(fakeTx, "planning", "completed", "in_progress"),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "PHASE_TRANSITION_INVALID");
        return true;
      },
    );
  });

  it("refuses skipped → pending", () => {
    assert.throws(
      () => phaseTransitionGuard(fakeTx, "planning", "skipped", "pending"),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "PHASE_TRANSITION_INVALID");
        return true;
      },
    );
  });

  it("refuses a target outside the known PhaseStatus set", () => {
    assert.throws(
      () => phaseTransitionGuard(fakeTx, "planning", "pending", "frobbed"),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "PHASE_TRANSITION_INVALID");
        return true;
      },
    );
  });
});

// ============================================================================
// OwnerCheckGuard
// ============================================================================

describe("ownerCheckGuard", () => {
  let projectDir: string;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
  });
  afterEach(() => {
    _resetInvariantsForTest();
    cleanup(projectDir);
  });

  it("passes when pipeline_state has no owner_id yet (pre-claim)", async () => {
    await seedPipelineState(projectDir, null);
    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      await ownerCheckGuard(tx, {
        driver_state_id: "d-fixture",
        caller_owner_id: "alice",
      });
    });
  });

  it("passes when caller is the same owner", async () => {
    await seedPipelineState(projectDir, "alice");
    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      await ownerCheckGuard(tx, {
        driver_state_id: "d-fixture",
        caller_owner_id: "alice",
      });
    });
  });

  it("refuses cross-owner without a marker (CROSS_OWNER_REQUIRED)", async () => {
    await seedPipelineState(projectDir, "alice");
    await assert.rejects(
      withStateTransaction(projectDir, captureNow(), async (tx) => {
        await ownerCheckGuard(tx, {
          driver_state_id: "d-fixture",
          caller_owner_id: "bob",
        });
      }),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "CROSS_OWNER_REQUIRED");
        return true;
      },
    );
  });

  it("with a marker, delegates to the forward-declared HMAC validator (NOT_IMPLEMENTED)", async () => {
    // The HMAC validator is forward-declared; the guard's job is
    // to reach the stub when a marker is supplied. The test asserts
    // the call gets that far by observing the NOT_IMPLEMENTED
    // throw — the proper success path (and INVALID / CONSUMED
    // codes) land alongside the cross-owner recovery primitive.
    await seedPipelineState(projectDir, "alice");
    const now = captureNow();
    await assert.rejects(
      withStateTransaction(projectDir, now, async (tx) => {
        await ownerCheckGuard(
          tx,
          { driver_state_id: "d-fixture", caller_owner_id: "bob" },
          { hmac: "stub", expires_at: tx.now },
        );
      }),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "NOT_IMPLEMENTED");
        return true;
      },
    );
  });
});

// ============================================================================
// BypassMarkerGuard
// ============================================================================

describe("bypassMarkerGuard", () => {
  const fakeTx = {
    now: "2026-05-28T12:00:00.000Z" as NowToken,
    audit_buffer: [] as Record<string, unknown>[],
    exec: async () => {},
    queryRow: async () => null,
    queryAll: async () => [],
  };

  it("refuses without a marker (BYPASS_MARKER_REQUIRED)", () => {
    assert.throws(
      () => bypassMarkerGuard(fakeTx, {}),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "BYPASS_MARKER_REQUIRED");
        return true;
      },
    );
  });

  it("refuses an expired marker via the tx.now comparison", () => {
    assert.throws(
      () =>
        bypassMarkerGuard(fakeTx, {
          marker: {
            hmac: "stub",
            expires_at: "2026-05-28T11:00:00.000Z" as NowToken, // 1h before tx.now
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "BYPASS_MARKER_EXPIRED");
        return true;
      },
    );
  });

  it("delegates to HMAC validator when marker is fresh (NOT_IMPLEMENTED)", () => {
    assert.throws(
      () =>
        bypassMarkerGuard(fakeTx, {
          marker: {
            hmac: "stub",
            expires_at: "2026-05-28T13:00:00.000Z" as NowToken, // 1h after tx.now
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "NOT_IMPLEMENTED");
        return true;
      },
    );
  });
});
