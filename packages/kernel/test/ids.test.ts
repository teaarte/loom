import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AGENT_RUN_ID_PATTERN,
  DRIVER_STATE_ID_PATTERN,
  FINDING_ID_PATTERN,
  GATE_EVENT_ID_PATTERN,
  TASK_ID_PATTERN,
  makeAgentRunId,
  makeDriverStateId,
  makeFindingId,
  makeGateEventId,
  makeTaskId,
  makeTaskIdWithHash,
} from "../src/ids.js";
import type { NowToken } from "../src/types/now.js";

const N = 100;

describe("id generators", () => {
  it("makeTaskId stays inside TASK_ID_PATTERN across N invocations", () => {
    for (let i = 0; i < N; i++) {
      const id = makeTaskId(`session ${i}`);
      assert.match(id, TASK_ID_PATTERN, `iteration ${i}: ${id}`);
    }
  });

  it("makeTaskIdWithHash stays inside TASK_ID_PATTERN", () => {
    for (let i = 0; i < N; i++) {
      const id = makeTaskIdWithHash(`session ${i}`);
      assert.match(id, TASK_ID_PATTERN, `iteration ${i}: ${id}`);
    }
  });

  it("makeAgentRunId stays inside AGENT_RUN_ID_PATTERN", () => {
    for (let i = 0; i < N; i++) {
      const id = makeAgentRunId();
      assert.match(id, AGENT_RUN_ID_PATTERN, `iteration ${i}: ${id}`);
    }
  });

  it("makeFindingId stays inside FINDING_ID_PATTERN", () => {
    for (let i = 0; i < N; i++) {
      const id = makeFindingId();
      assert.match(id, FINDING_ID_PATTERN, `iteration ${i}: ${id}`);
    }
  });

  it("makeDriverStateId stays inside DRIVER_STATE_ID_PATTERN", () => {
    for (let i = 0; i < N; i++) {
      const id = makeDriverStateId();
      assert.match(id, DRIVER_STATE_ID_PATTERN, `iteration ${i}: ${id}`);
    }
  });

  it("makeGateEventId stays inside GATE_EVENT_ID_PATTERN", () => {
    for (let i = 0; i < N; i++) {
      const id = makeGateEventId();
      assert.match(id, GATE_EVENT_ID_PATTERN, `iteration ${i}: ${id}`);
    }
  });
});

describe("deterministic NowToken injection", () => {
  it("same NowToken + same slug → same makeTaskId output", () => {
    const now = "2026-05-27T12:34:56.000Z" as NowToken;
    const a = makeTaskId("widget refactor", now);
    const b = makeTaskId("widget refactor", now);
    assert.equal(a, b);
    assert.equal(a, "t-2026-05-27-widgetrefactor");
  });

  it("sanitizes slugs to [a-z0-9]+ only", () => {
    const now = "2026-05-27T00:00:00.000Z" as NowToken;
    const id = makeTaskId("FOO bar! @#$ 123", now);
    assert.equal(id, "t-2026-05-27-foobar123");
    assert.match(id, TASK_ID_PATTERN);
  });

  it("falls back to 'task' when slug sanitizes to empty", () => {
    const now = "2026-05-27T00:00:00.000Z" as NowToken;
    const id = makeTaskId("!!!", now);
    assert.equal(id, "t-2026-05-27-task");
    assert.match(id, TASK_ID_PATTERN);
  });

  it("makeFindingId honors the injected date prefix", () => {
    const now = "2025-01-15T00:00:00.000Z" as NowToken;
    const id = makeFindingId(now);
    assert.ok(id.startsWith("f-2025-01-15-"), `unexpected prefix: ${id}`);
    assert.match(id, FINDING_ID_PATTERN);
  });

  // The slug is capped so a task_id stays a short handle — it is echoed
  // into every spawn prompt and FKs onto every findings/audit/ledger row.
  // A whole-brief slug (no cap) produced a ~1500-char tail.
  it("caps the slug so a giant brief mints a short, valid task_id", () => {
    const now = "2026-05-27T00:00:00.000Z" as NowToken;
    const brief = "implement ".repeat(400); // ~4000 chars of words
    const id = makeTaskId(brief, now);
    assert.match(id, TASK_ID_PATTERN);
    const slug = id.slice("t-2026-05-27-".length);
    assert.ok(slug.length <= 48, `slug should be capped; got ${slug.length} chars`);
    assert.ok(id.length <= 64, `task_id should stay short; got ${id.length} chars`);
  });
});
