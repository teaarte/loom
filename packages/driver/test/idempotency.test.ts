import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deterministicUuid } from "../src/idempotency.js";

describe("deterministicUuid", () => {
  it("is stable: the same task always derives the same id", () => {
    // The load-bearing property — the uuid keys the task-create ledger row, so
    // a resubmit of the SAME task must derive the SAME id to replay the cached
    // creation. (This is why the derivation lives in one place: two byte-equal
    // copies in submit + the supervisor could silently drift.)
    const task = "add a health check route to the server";
    assert.equal(deterministicUuid(task), deterministicUuid(task));
  });

  it("differs for different tasks", () => {
    assert.notEqual(deterministicUuid("task A"), deterministicUuid("task B"));
  });

  it("carries the cidem- prefix and a fixed-width hex digest", () => {
    const id = deterministicUuid("anything");
    assert.match(id, /^cidem-[0-9a-f]{24}$/);
  });

  it("is sensitive to whitespace (callers trim before deriving)", () => {
    // The intake paths trim the task before deriving; this pins that a raw,
    // untrimmed string is a DIFFERENT key, so the trim is not optional.
    assert.notEqual(deterministicUuid("x"), deterministicUuid(" x "));
  });
});
