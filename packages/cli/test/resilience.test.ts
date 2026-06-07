// Operational resilience knobs — duration parsing and the per-spawn timeout
// defaults. The load-bearing change: a per-spawn SESSION cap is now ON by
// default so a wedged spawn is killed → re-driven → eventually parked, never
// hung; idle stays env-only (the primary backend buffers, so a default idle cap
// would false-kill legitimate long-but-silent spawns).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_HARNESS_SPAWN_SESSION_TIMEOUT_MS,
  DEFAULT_SPAWN_SESSION_TIMEOUT_MS,
  parseDurationMs,
  resolveHarnessSpawnTimeouts,
  resolveSpawnTimeouts,
} from "../src/lib/resilience.js";

describe("parseDurationMs", () => {
  it("reads a plain integer as ms and accepts s/m/h suffixes", () => {
    assert.equal(parseDurationMs("500"), 500);
    assert.equal(parseDurationMs("30s"), 30_000);
    assert.equal(parseDurationMs("5m"), 300_000);
    assert.equal(parseDurationMs("1h"), 3_600_000);
    assert.equal(parseDurationMs("250ms"), 250);
  });

  it("is undefined on unset / blank / malformed input", () => {
    assert.equal(parseDurationMs(undefined), undefined);
    assert.equal(parseDurationMs("  "), undefined);
    assert.equal(parseDurationMs("soon"), undefined);
    assert.equal(parseDurationMs("-5"), undefined);
  });
});

describe("resolveSpawnTimeouts — session cap defaults ON", () => {
  it("applies the default session cap when nothing is set (and no idle by default)", () => {
    const t = resolveSpawnTimeouts({});
    assert.equal(t.session_timeout_ms, DEFAULT_SPAWN_SESSION_TIMEOUT_MS);
    assert.equal(t.idle_timeout_ms, undefined);
  });

  it("an explicit positive value overrides the default", () => {
    const t = resolveSpawnTimeouts({ LOOM_SPAWN_SESSION_TIMEOUT_MS: "10m" });
    assert.equal(t.session_timeout_ms, 600_000);
  });

  it("an explicit 0 disables the session cap (opt-out)", () => {
    const t = resolveSpawnTimeouts({ LOOM_SPAWN_SESSION_TIMEOUT_MS: "0" });
    assert.equal(t.session_timeout_ms, undefined);
  });

  it("a malformed value keeps a cap in force (falls back to the default)", () => {
    const t = resolveSpawnTimeouts({ LOOM_SPAWN_SESSION_TIMEOUT_MS: "whenever" });
    assert.equal(t.session_timeout_ms, DEFAULT_SPAWN_SESSION_TIMEOUT_MS);
  });

  it("idle stays env-only — set only when explicitly given a positive value", () => {
    assert.equal(resolveSpawnTimeouts({ LOOM_SPAWN_IDLE_TIMEOUT_MS: "90s" }).idle_timeout_ms, 90_000);
    assert.equal(resolveSpawnTimeouts({ LOOM_SPAWN_IDLE_TIMEOUT_MS: "0" }).idle_timeout_ms, undefined);
  });
});

describe("resolveHarnessSpawnTimeouts — shorter default for non-CC harnesses", () => {
  it("defaults to the shorter harness cap (10m, vs the 30m Claude default)", () => {
    const t = resolveHarnessSpawnTimeouts({});
    assert.equal(t.session_timeout_ms, DEFAULT_HARNESS_SPAWN_SESSION_TIMEOUT_MS);
    assert.equal(DEFAULT_HARNESS_SPAWN_SESSION_TIMEOUT_MS < DEFAULT_SPAWN_SESSION_TIMEOUT_MS, true);
  });

  it("honors LOOM_HARNESS_SPAWN_SESSION_TIMEOUT_MS override and 0=disable", () => {
    assert.equal(
      resolveHarnessSpawnTimeouts({ LOOM_HARNESS_SPAWN_SESSION_TIMEOUT_MS: "3m" }).session_timeout_ms,
      180_000,
    );
    assert.equal(
      resolveHarnessSpawnTimeouts({ LOOM_HARNESS_SPAWN_SESSION_TIMEOUT_MS: "0" }).session_timeout_ms,
      undefined,
    );
  });

  it("does NOT read the general session knob (that one stays Claude-only)", () => {
    // A general 0 opt-out must not disable the harness cap — they are independent.
    assert.equal(
      resolveHarnessSpawnTimeouts({ LOOM_SPAWN_SESSION_TIMEOUT_MS: "0" }).session_timeout_ms,
      DEFAULT_HARNESS_SPAWN_SESSION_TIMEOUT_MS,
    );
  });

  it("idle: harness-specific knob wins, else falls back to the general idle knob", () => {
    assert.equal(
      resolveHarnessSpawnTimeouts({ LOOM_HARNESS_SPAWN_IDLE_TIMEOUT_MS: "45s" }).idle_timeout_ms,
      45_000,
    );
    assert.equal(
      resolveHarnessSpawnTimeouts({ LOOM_SPAWN_IDLE_TIMEOUT_MS: "30s" }).idle_timeout_ms,
      30_000,
    );
  });
});
