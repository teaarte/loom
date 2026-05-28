import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  KERNEL_POLICY_PRESETS,
  resolvePreset,
} from "../src/policy-presets/index.js";
import { KernelError } from "../src/state/db.js";

describe("policy presets — kernel-shipped catalogue", () => {
  it("full-supervised → every role human", () => {
    const p = resolvePreset("full-supervised");
    assert.equal(p["classify"], "human");
    assert.equal(p["plan"], "human");
    assert.equal(p["final"], "human");
  });

  it("review-plan-only → plan human, others auto", () => {
    const p = resolvePreset("review-plan-only");
    assert.equal(p["plan"], "human");
    assert.equal(p["classify"], "auto");
    assert.equal(p["final"], "auto");
  });

  it("review-final-only → final human, others auto", () => {
    const p = resolvePreset("review-final-only");
    assert.equal(p["final"], "human");
    assert.equal(p["classify"], "auto");
    assert.equal(p["plan"], "auto");
  });

  it("gates-on-blockers → every role on-blockers", () => {
    const p = resolvePreset("gates-on-blockers");
    assert.equal(p["classify"], "on-blockers");
    assert.equal(p["plan"], "on-blockers");
    assert.equal(p["final"], "on-blockers");
  });

  it("full-autonomous → every role auto", () => {
    const p = resolvePreset("full-autonomous");
    assert.equal(p["classify"], "auto");
    assert.equal(p["plan"], "auto");
    assert.equal(p["final"], "auto");
  });

  it("POLICY_PRESET_UNKNOWN on unregistered name", () => {
    assert.throws(
      () => resolvePreset("nonexistent-preset"),
      (err: unknown) =>
        err instanceof KernelError && err.code === "POLICY_PRESET_UNKNOWN",
    );
  });

  it("catalogue exposes exactly the five kernel-shipped presets", () => {
    const names = [...KERNEL_POLICY_PRESETS.keys()].sort();
    assert.deepEqual(names, [
      "full-autonomous",
      "full-supervised",
      "gates-on-blockers",
      "review-final-only",
      "review-plan-only",
    ]);
  });
});
