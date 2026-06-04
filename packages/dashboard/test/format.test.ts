// The log/elapsed formatters: pure (no DOM), domain-blind. They turn the
// generic FSM log + status shape into human-readable pieces a renderer lays out.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  elapsedFor,
  formatDetail,
  formatDetailValue,
  formatDuration,
  logParts,
} from "../src/lib/format.js";

describe("formatDetailValue", () => {
  it("pretties a cost_usd number as a dollar amount", () => {
    assert.equal(formatDetailValue("cost_usd", 2.523), "$2.52");
    assert.equal(formatDetailValue("cost_usd", 0), "$0.00");
  });
  it("passes through plain numbers and strings", () => {
    assert.equal(formatDetailValue("tokens_in", 1234), "1234");
    assert.equal(formatDetailValue("gate", "plan"), "plan");
  });
  it("shallow-stringifies an object/array value", () => {
    assert.equal(formatDetailValue("files", ["a", "b"]), '["a","b"]');
  });
});

describe("formatDetail", () => {
  it("renders compact key value pairs, not raw JSON", () => {
    assert.equal(
      formatDetail({ tokens_in: 10, cost_usd: 1.5 }),
      "tokens_in 10  cost_usd $1.50",
    );
  });
  it("is empty for no detail", () => {
    assert.equal(formatDetail(undefined), "");
  });
});

describe("logParts", () => {
  it("splits a line into clock/level/event/detail with a default level", () => {
    const p = logParts({ ts: "2026-06-04T00:00:00.000Z", event: "spawn-usage", detail: { num_turns: 3 } });
    assert.equal(p.level, "info");
    assert.equal(p.event, "spawn-usage");
    assert.equal(p.detail, "num_turns 3");
    assert.match(p.clock, /^\d\d:\d\d:\d\d$/);
  });
  it("tolerates a bare line", () => {
    assert.deepEqual(logParts({}), { clock: "", level: "info", event: "", detail: "" });
  });
});

describe("formatDuration", () => {
  it("formats sub-minute, sub-hour, and multi-hour spans", () => {
    assert.equal(formatDuration(12_000), "12s");
    assert.equal(formatDuration(123_000), "2m 03s");
    assert.equal(formatDuration(3_723_000), "1h 02m 03s");
  });
  it("clamps negative / non-finite to 0s", () => {
    assert.equal(formatDuration(-5), "0s");
    assert.equal(formatDuration(NaN), "0s");
  });
});

describe("elapsedFor", () => {
  it("measures to ended_at when terminal", () => {
    assert.equal(
      elapsedFor("2026-06-04T00:00:00.000Z", "2026-06-04T00:02:03.000Z", Date.parse("2026-06-04T09:00:00Z")),
      "2m 03s",
    );
  });
  it("measures to nowMs while live (no ended_at)", () => {
    const start = "2026-06-04T00:00:00.000Z";
    assert.equal(elapsedFor(start, null, Date.parse(start) + 45_000), "45s");
  });
  it("is empty without a usable start", () => {
    assert.equal(elapsedFor(null, null, 0), "");
    assert.equal(elapsedFor("not-a-date", null, 0), "");
  });
});
