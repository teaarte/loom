// The generic retry policy — classification by error CODE (never domain) and
// the capped exponential backoff. Pure functions, no store.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  backoffDelayMs,
  DEFAULT_RETRY_POLICY,
  defaultClassifier,
  type RetryPolicy,
} from "../src/index.js";

describe("retry — error classification (by code, not domain)", () => {
  it("treats a dropped/missing backend round-trip as transient", () => {
    assert.equal(defaultClassifier("EXECUTOR_FAILED"), "transient");
    assert.equal(defaultClassifier("EXECUTOR_NOT_FOUND"), "transient");
  });

  it("treats a wedged-spawn timeout (session/idle) as transient — re-drive", () => {
    assert.equal(defaultClassifier("EXECUTOR_TIMEOUT"), "transient");
    assert.equal(defaultClassifier("EXECUTOR_IDLE_TIMEOUT"), "transient");
  });

  it("treats a recognised rate-limit as its own wait class, not transient", () => {
    assert.equal(defaultClassifier("EXECUTOR_RATE_LIMITED"), "rate-limited");
  });

  it("escalates structural / deliberate errors rather than spinning", () => {
    assert.equal(defaultClassifier("SPAWN_BUDGET_EXCEEDED"), "terminal");
    assert.equal(defaultClassifier("KERNEL_INVARIANT"), "terminal");
    assert.equal(defaultClassifier("NO_ACTIVE_TASK"), "terminal");
    assert.equal(defaultClassifier("FLOW_OVERFLOW"), "terminal");
    assert.equal(defaultClassifier("DRIVE_ABORTED"), "terminal");
    // An unknown code defaults to terminal — escalate, never loop forever.
    assert.equal(defaultClassifier("SOMETHING_NEW"), "terminal");
  });
});

describe("retry — capped exponential backoff", () => {
  it("grows by the factor and caps at the ceiling", () => {
    const p: RetryPolicy = { max_attempts: 10, base_delay_ms: 100, factor: 2, ceiling_ms: 1_000 };
    assert.equal(backoffDelayMs(p, 1), 100);
    assert.equal(backoffDelayMs(p, 2), 200);
    assert.equal(backoffDelayMs(p, 3), 400);
    assert.equal(backoffDelayMs(p, 4), 800);
    // 1600 would exceed the ceiling → capped.
    assert.equal(backoffDelayMs(p, 5), 1_000);
    assert.equal(backoffDelayMs(p, 50), 1_000);
  });

  it("never exceeds the ceiling even on the first attempt", () => {
    const p: RetryPolicy = { max_attempts: 3, base_delay_ms: 5_000, factor: 2, ceiling_ms: 1_000 };
    assert.equal(backoffDelayMs(p, 1), 1_000);
  });

  it("ships sane defaults", () => {
    assert.ok(DEFAULT_RETRY_POLICY.max_attempts >= 1);
    assert.ok(DEFAULT_RETRY_POLICY.ceiling_ms >= DEFAULT_RETRY_POLICY.base_delay_ms);
  });
});
