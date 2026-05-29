import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  bypassMarkerGuard,
  ownerCheckGuard,
  phaseTransitionGuard,
  spawnGuard,
  type BypassMarker,
} from "../src/guards.js";
import {
  computeMarkerHmac,
  crossOwnerReason,
  issueCrossOwnerMarker,
  loadBypassKey,
  markerExpiresAt,
} from "../src/lib/bypass-marker.js";
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

// Two distinct ≥32-byte keys for the signing / rotation cases. base64 of
// constant bytes — deterministic, no clock / randomness.
const ENV_KEY_A = Buffer.alloc(32, 0xa1).toString("base64");
const ENV_KEY_B = Buffer.alloc(32, 0xb2).toString("base64");

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

  it("honors a custom duplicate_window_ms", async () => {
    // Insert a pending row 3 minutes old. With a 5-minute default
    // it would trip the guard; with a custom 1-minute window the
    // row is past it and the guard should let the new spawn
    // through. Exercising both verdicts proves the parameter
    // actually flows into the cutoff computation — not just the
    // default constant.
    await seedPipelineState(projectDir, null);
    const seedNow = captureNow();
    const threeMinAgoEpoch = Date.parse(seedNow) - 3 * 60 * 1000;
    const threeMinAgo = new Date(threeMinAgoEpoch).toISOString() as NowToken; // allow-ambient-clock: derives from a parsed NowToken string only; never reads the host clock
    await withStateTransaction(projectDir, seedNow, async (tx) => {
      await tx.exec(
        "INSERT INTO pending_agents (agent_run_id, agent, phase, started_at) " +
          "VALUES (?, ?, ?, ?)",
        ["ar-mid-001", "planner", "planning", threeMinAgo],
      );
    });

    // Custom window=1min → 3-min-old row is past it → allowed.
    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      await spawnGuard(tx, "planner", "planning", {
        duplicate_window_ms: 60 * 1000,
      });
    });

    // Custom window=10min → 3-min-old row is inside it → refused.
    await assert.rejects(
      withStateTransaction(projectDir, captureNow(), async (tx) => {
        await spawnGuard(tx, "planner", "planning", {
          duplicate_window_ms: 10 * 60 * 1000,
        });
      }),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "DUPLICATE_SPAWN");
        return true;
      },
    );
  });

  it("reads tx.now (not the host clock) for the duplicate-window cutoff", async () => {
    // Replay-determinism property at the guard layer: feeding the
    // same DB-state with two NowTokens N minutes apart should flip
    // the verdict, proving the cutoff is `tx.now - window` and not
    // `Date.now() - window`. Without this, a delayed replay would
    // produce a different verdict than the original commit — the
    // very thing the NowToken contract is supposed to prevent.
    //
    // Every timestamp anchors to `captureNow()` so the seed row stays
    // fresh against the zombie-pending invariant (INV_015, 50-min
    // threshold). An absolute fixture timestamp would rot under a
    // delayed run — the duplicate-window verdict is the only thing
    // this test asserts.
    await seedPipelineState(projectDir, null);

    const anchor = Date.parse(captureNow());
    const stampedAt = new Date(anchor - 2 * 60 * 1000).toISOString() as NowToken; // allow-ambient-clock: derives from a parsed NowToken string only; never reads the host clock
    const insideWindow = new Date(anchor).toISOString() as NowToken; // allow-ambient-clock: derives from a parsed NowToken string only
    const outsideWindow = new Date(anchor + 8 * 60 * 1000).toISOString() as NowToken; // allow-ambient-clock: derives from a parsed NowToken string only

    await withStateTransaction(projectDir, captureNow(), async (tx) => {
      await tx.exec(
        "INSERT INTO pending_agents (agent_run_id, agent, phase, started_at) " +
          "VALUES (?, ?, ?, ?)",
        ["ar-clock-001", "planner", "planning", stampedAt],
      );
    });

    // tx.now = 2 minutes after stampedAt → within 5-min window → refused.
    await assert.rejects(
      withStateTransaction(projectDir, insideWindow, async (tx) => {
        await spawnGuard(tx, "planner", "planning");
      }),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "DUPLICATE_SPAWN");
        return true;
      },
    );

    // tx.now = 10 minutes after stampedAt → past 5-min window → allowed.
    await withStateTransaction(projectDir, outsideWindow, async (tx) => {
      await spawnGuard(tx, "planner", "planning");
    });
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
  let prevEnv: string | undefined;
  let prevHome: string | undefined;
  beforeEach(() => {
    _resetInvariantsForTest();
    projectDir = freshProject();
    prevEnv = process.env["PIPELINE_BYPASS_HMAC_KEY"];
    prevHome = process.env["HOME"];
    process.env["PIPELINE_BYPASS_HMAC_KEY"] = ENV_KEY_A;
  });
  afterEach(() => {
    _resetInvariantsForTest();
    restoreEnv("PIPELINE_BYPASS_HMAC_KEY", prevEnv);
    restoreEnv("HOME", prevHome);
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

  it("a valid marker authorizes the cross-owner op and is consumed", async () => {
    await seedPipelineState(projectDir, "alice");
    const now = captureNow();
    const marker = await withStateTransaction(projectDir, now, (tx) =>
      issueCrossOwnerMarker(tx, { driver_state_id: "d-fixture", ttl_ms: 60_000 }),
    );

    // The guard verifies + consumes in the same tx; no throw means the
    // cross-owner op is authorized.
    await withStateTransaction(projectDir, now, async (tx) => {
      await ownerCheckGuard(
        tx,
        { driver_state_id: "d-fixture", caller_owner_id: "bob" },
        toGuardMarker(marker),
      );
    });

    // Single-use: the bypass_markers row is gone after the consume.
    const row = await withStateTransaction(projectDir, now, (tx) =>
      tx.queryRow("SELECT id FROM bypass_markers WHERE id = 1"),
    );
    assert.equal(row, null);
  });

  it("refuses a forged marker (bad signature) with CROSS_OWNER_MARKER_INVALID", async () => {
    await seedPipelineState(projectDir, "alice");
    const now = captureNow();
    const key = loadBypassKey();
    assert.ok(key !== null);
    const forged: BypassMarker = {
      issued_at: now,
      expires_at: markerExpiresAt(now, 60_000),
      reason: crossOwnerReason("d-fixture"),
      key_id: key.key_id,
      hmac: "0".repeat(64), // valid-length hex, wrong signature
    };
    await assert.rejects(
      withStateTransaction(projectDir, now, async (tx) => {
        await ownerCheckGuard(
          tx,
          { driver_state_id: "d-fixture", caller_owner_id: "bob" },
          forged,
        );
      }),
      (err: unknown) =>
        err instanceof KernelError && err.code === "CROSS_OWNER_MARKER_INVALID",
    );
  });

  it("refuses an expired marker with BYPASS_MARKER_EXPIRED", async () => {
    await seedPipelineState(projectDir, "alice");
    const key = loadBypassKey();
    assert.ok(key !== null);
    const issued = "2026-05-29T11:00:00.000Z" as NowToken;
    const expired = "2026-05-29T11:30:00.000Z" as NowToken;
    const reason = crossOwnerReason("d-fixture");
    const marker: BypassMarker = {
      issued_at: issued,
      expires_at: expired,
      reason,
      key_id: key.key_id,
      hmac: computeMarkerHmac(key.key, issued, expired, reason),
    };
    // tx.now is well after expires_at.
    const now = "2026-05-29T12:00:00.000Z" as NowToken;
    await assert.rejects(
      withStateTransaction(projectDir, now, async (tx) => {
        await ownerCheckGuard(
          tx,
          { driver_state_id: "d-fixture", caller_owner_id: "bob" },
          marker,
        );
      }),
      (err: unknown) =>
        err instanceof KernelError && err.code === "BYPASS_MARKER_EXPIRED",
    );
  });

  it("refuses a marker minted for a different driver_state_id", async () => {
    await seedPipelineState(projectDir, "alice");
    const now = captureNow();
    const key = loadBypassKey();
    assert.ok(key !== null);
    const reason = crossOwnerReason("d-some-other-task");
    const expires = markerExpiresAt(now, 60_000);
    const marker: BypassMarker = {
      issued_at: now,
      expires_at: expires,
      reason,
      key_id: key.key_id,
      hmac: computeMarkerHmac(key.key, now, expires, reason),
    };
    await assert.rejects(
      withStateTransaction(projectDir, now, async (tx) => {
        await ownerCheckGuard(
          tx,
          { driver_state_id: "d-fixture", caller_owner_id: "bob" },
          marker,
        );
      }),
      (err: unknown) =>
        err instanceof KernelError && err.code === "CROSS_OWNER_MARKER_INVALID",
    );
  });

  it("refuses a marker signed under a now-rotated key", async () => {
    await seedPipelineState(projectDir, "alice");
    const now = captureNow();
    const marker = await withStateTransaction(projectDir, now, (tx) =>
      issueCrossOwnerMarker(tx, { driver_state_id: "d-fixture", ttl_ms: 60_000 }),
    );
    // Rotate the active key — the marker's key_id no longer matches.
    process.env["PIPELINE_BYPASS_HMAC_KEY"] = ENV_KEY_B;
    await assert.rejects(
      withStateTransaction(projectDir, now, async (tx) => {
        await ownerCheckGuard(
          tx,
          { driver_state_id: "d-fixture", caller_owner_id: "bob" },
          toGuardMarker(marker),
        );
      }),
      (err: unknown) =>
        err instanceof KernelError && err.code === "CROSS_OWNER_MARKER_INVALID",
    );
  });

  it("a consumed marker replays as CROSS_OWNER_MARKER_CONSUMED", async () => {
    await seedPipelineState(projectDir, "alice");
    const now = captureNow();
    const marker = await withStateTransaction(projectDir, now, (tx) =>
      issueCrossOwnerMarker(tx, { driver_state_id: "d-fixture", ttl_ms: 60_000 }),
    );
    // First use consumes the row.
    await withStateTransaction(projectDir, now, async (tx) => {
      await ownerCheckGuard(
        tx,
        { driver_state_id: "d-fixture", caller_owner_id: "bob" },
        toGuardMarker(marker),
      );
    });
    // Replay of the same (now-consumed) marker — valid signature, no row.
    await assert.rejects(
      withStateTransaction(projectDir, now, async (tx) => {
        await ownerCheckGuard(
          tx,
          { driver_state_id: "d-fixture", caller_owner_id: "bob" },
          toGuardMarker(marker),
        );
      }),
      (err: unknown) =>
        err instanceof KernelError && err.code === "CROSS_OWNER_MARKER_CONSUMED",
    );
  });

  it("refuses with BYPASS_KEY_MISSING when no signing key is configured", async () => {
    await seedPipelineState(projectDir, "alice");
    // No env key, and a home dir with no key file → loadBypassKey null.
    delete process.env["PIPELINE_BYPASS_HMAC_KEY"];
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "loom-emptyhome-"));
    const now = captureNow();
    const marker: BypassMarker = {
      issued_at: now,
      expires_at: markerExpiresAt(now, 60_000),
      reason: crossOwnerReason("d-fixture"),
      key_id: "env:deadbeef",
      hmac: "0".repeat(64),
    };
    await assert.rejects(
      withStateTransaction(projectDir, now, async (tx) => {
        await ownerCheckGuard(
          tx,
          { driver_state_id: "d-fixture", caller_owner_id: "bob" },
          marker,
        );
      }),
      (err: unknown) =>
        err instanceof KernelError && err.code === "BYPASS_KEY_MISSING",
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

  let prevEnv: string | undefined;
  let prevHome: string | undefined;
  beforeEach(() => {
    prevEnv = process.env["PIPELINE_BYPASS_HMAC_KEY"];
    prevHome = process.env["HOME"];
    process.env["PIPELINE_BYPASS_HMAC_KEY"] = ENV_KEY_A;
  });
  afterEach(() => {
    restoreEnv("PIPELINE_BYPASS_HMAC_KEY", prevEnv);
    restoreEnv("HOME", prevHome);
  });

  // Build a fresh direct-write marker signed under the active key.
  function freshMarker(): BypassMarker {
    const key = loadBypassKey();
    assert.ok(key !== null);
    const issued = "2026-05-28T11:30:00.000Z" as NowToken;
    const expires = "2026-05-28T13:00:00.000Z" as NowToken; // after fakeTx.now
    const reason = "direct-write";
    return {
      issued_at: issued,
      expires_at: expires,
      reason,
      key_id: key.key_id,
      hmac: computeMarkerHmac(key.key, issued, expires, reason),
    };
  }

  it("refuses without a marker (BYPASS_MARKER_REQUIRED)", () => {
    assert.throws(
      () => bypassMarkerGuard(fakeTx, {}),
      (err: unknown) =>
        err instanceof KernelError && err.code === "BYPASS_MARKER_REQUIRED",
    );
  });

  it("refuses an expired marker via the tx.now comparison", () => {
    const m = freshMarker();
    m.expires_at = "2026-05-28T11:00:00.000Z" as NowToken; // 1h before tx.now
    assert.throws(
      () => bypassMarkerGuard(fakeTx, { marker: m }),
      (err: unknown) =>
        err instanceof KernelError && err.code === "BYPASS_MARKER_EXPIRED",
    );
  });

  it("passes a fresh marker with a valid signature", () => {
    bypassMarkerGuard(fakeTx, { marker: freshMarker() });
  });

  it("refuses a fresh marker with a bad signature (BYPASS_MARKER_INVALID)", () => {
    const m = freshMarker();
    m.hmac = "0".repeat(64);
    assert.throws(
      () => bypassMarkerGuard(fakeTx, { marker: m }),
      (err: unknown) =>
        err instanceof KernelError && err.code === "BYPASS_MARKER_INVALID",
    );
  });

  it("refuses with BYPASS_KEY_MISSING when no signing key is configured", () => {
    const m = freshMarker();
    delete process.env["PIPELINE_BYPASS_HMAC_KEY"];
    process.env["HOME"] = mkdtempSync(join(tmpdir(), "loom-emptyhome-"));
    assert.throws(
      () => bypassMarkerGuard(fakeTx, { marker: m }),
      (err: unknown) =>
        err instanceof KernelError && err.code === "BYPASS_KEY_MISSING",
    );
  });
});

// Restore an env var to a prior value (delete if it was unset).
function restoreEnv(name: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[name];
  else process.env[name] = prev;
}

// The issued marker carries the same fields the guard's BypassMarker
// expects; the NowToken brand is structural so the shapes line up.
function toGuardMarker(m: {
  issued_at: string;
  expires_at: string;
  reason: string;
  hmac: string;
  key_id: string;
}): BypassMarker {
  return {
    issued_at: m.issued_at as NowToken,
    expires_at: m.expires_at as NowToken,
    reason: m.reason,
    hmac: m.hmac,
    key_id: m.key_id,
  };
}
