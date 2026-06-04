// Operational resilience knobs — duration parsing and the per-spawn timeout
// defaults. The load-bearing change: a per-spawn SESSION cap is now ON by
// default so a wedged spawn is killed → re-driven → eventually parked, never
// hung; idle stays env-only (the primary backend buffers, so a default idle cap
// would false-kill legitimate long-but-silent spawns).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_SPAWN_SESSION_TIMEOUT_MS,
  parseDurationMs,
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
