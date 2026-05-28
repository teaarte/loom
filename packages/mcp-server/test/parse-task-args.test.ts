import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FLAG_TO_PRESET, parseTaskArgs } from "../src/lib/parse-task-args.js";

describe("parseTaskArgs", () => {
  it("maps each known leading flag to the documented preset", () => {
    const cases: [string, string][] = [
      ["--supervised", "full-supervised"],
      ["--auto", "full-autonomous"],
      ["--review-plan", "review-plan-only"],
      ["--review-final", "review-final-only"],
      ["--gates-on-blockers", "gates-on-blockers"],
    ];
    for (const [flag, preset] of cases) {
      const result = parseTaskArgs(`${flag} fix the login bug`);
      assert.equal(result.policy_preset, preset);
      assert.equal(result.task, "fix the login bug");
      assert.deepEqual(result.warnings, []);
    }
  });

  it("FLAG_TO_PRESET carries exactly the five registered entries", () => {
    assert.deepEqual(Object.keys(FLAG_TO_PRESET).sort(), [
      "--auto",
      "--gates-on-blockers",
      "--review-final",
      "--review-plan",
      "--supervised",
    ]);
  });

  it("returns an empty envelope for empty input", () => {
    const result = parseTaskArgs("");
    assert.deepEqual(result, { task: "", warnings: [] });
  });

  it("returns an empty envelope for whitespace-only input", () => {
    const result = parseTaskArgs("   \n\t  ");
    assert.deepEqual(result, { task: "", warnings: [] });
  });

  it("passes through a task with no leading flag", () => {
    const result = parseTaskArgs("just fix the bug please");
    assert.equal(result.task, "just fix the bug please");
    assert.equal(result.policy_preset, undefined);
    assert.deepEqual(result.warnings, []);
  });

  it("surfaces unknown-flag warning with em-dash separator", () => {
    const result = parseTaskArgs("--turbo do the thing");
    assert.equal(result.task, "do the thing");
    assert.equal(result.policy_preset, undefined);
    assert.deepEqual(result.warnings, [
      "unknown-flag: --turbo — treated as no-op (task starts after flag)",
    ]);
  });

  it("treats a non-leading flag as task text", () => {
    const result = parseTaskArgs("fix --auto thing");
    assert.equal(result.task, "fix --auto thing");
    assert.equal(result.policy_preset, undefined);
    assert.deepEqual(result.warnings, []);
  });

  it("treats a bare flag with no rest as pass-through task text", () => {
    const result = parseTaskArgs("--auto");
    assert.equal(result.task, "--auto");
    assert.equal(result.policy_preset, undefined);
    assert.deepEqual(result.warnings, []);
  });

  it("preserves multi-line task text after a leading flag", () => {
    const raw = "--auto fix\nthe\nbug";
    const result = parseTaskArgs(raw);
    assert.equal(result.policy_preset, "full-autonomous");
    assert.equal(result.task, "fix\nthe\nbug");
  });

  it("matches only the FIRST leading flag — a second flag stays in task text", () => {
    const result = parseTaskArgs("--auto --review-plan fix bug");
    assert.equal(result.policy_preset, "full-autonomous");
    assert.equal(result.task, "--review-plan fix bug");
    assert.deepEqual(result.warnings, []);
  });

  it("rejects uppercase flags (regex is [a-z] only) and passes them through", () => {
    const result = parseTaskArgs("--AUTO fix bug");
    assert.equal(result.task, "--AUTO fix bug");
    assert.equal(result.policy_preset, undefined);
    assert.deepEqual(result.warnings, []);
  });

  it("rejects a bare '--' prefix and treats it as task text", () => {
    const result = parseTaskArgs("-- fix bug");
    assert.equal(result.task, "-- fix bug");
    assert.equal(result.policy_preset, undefined);
    assert.deepEqual(result.warnings, []);
  });
});
