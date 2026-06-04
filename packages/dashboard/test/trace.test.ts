// The agent-chain helpers: pure (no DOM), domain-blind. They derive a per-run
// duration from the chain's persist timestamps and join structured output to a
// run by the generic columns the store records — naming no bundle vocabulary.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compact,
  deriveAgentDurations,
  findingsForAgent,
  tokenSummary,
  verdictsForAgent,
} from "../src/lib/trace.js";
import type { TraceAgent, TraceFinding, TraceVerdict } from "../src/lib/types.js";

function agent(over: Partial<TraceAgent> & Pick<TraceAgent, "agent_run_id" | "recorded_at">): TraceAgent {
  return {
    agent: "a",
    phase: "p",
    model: null,
    output_kind: "nonreview",
    tokens_in: null,
    tokens_out: null,
    tokens_cached: null,
    ...over,
  };
}

describe("deriveAgentDurations", () => {
  it("anchors the first run to started_at and each later run to the previous", () => {
    const agents: TraceAgent[] = [
      agent({ agent_run_id: "r1", agent: "alpha", recorded_at: "2026-06-04T00:00:10.000Z" }),
      agent({ agent_run_id: "r2", agent: "beta", recorded_at: "2026-06-04T00:00:40.000Z" }),
    ];
    const timed = deriveAgentDurations(agents, "2026-06-04T00:00:00.000Z");
    assert.equal(timed[0]?.duration_ms, 10_000);
    assert.equal(timed[1]?.duration_ms, 30_000);
    // The run data rides through unchanged — names are DATA.
    assert.equal(timed[0]?.agent, "alpha");
    assert.equal(timed[1]?.agent, "beta");
  });

  it("yields null when the anchor is missing or a delta is negative", () => {
    const agents: TraceAgent[] = [
      agent({ agent_run_id: "r1", recorded_at: "2026-06-04T00:00:10.000Z" }),
      agent({ agent_run_id: "r2", recorded_at: "2026-06-04T00:00:05.000Z" }), // earlier than r1
    ];
    const noStart = deriveAgentDurations(agents, null);
    assert.equal(noStart[0]?.duration_ms, null);
    const withStart = deriveAgentDurations(agents, "2026-06-04T00:00:00.000Z");
    assert.equal(withStart[0]?.duration_ms, 10_000);
    assert.equal(withStart[1]?.duration_ms, null); // negative delta → null
  });

  it("tolerates an unparseable timestamp", () => {
    const timed = deriveAgentDurations([agent({ agent_run_id: "r1", recorded_at: "nope" })], "2026-06-04T00:00:00.000Z");
    assert.equal(timed[0]?.duration_ms, null);
  });
});

describe("findingsForAgent / verdictsForAgent", () => {
  const findings: TraceFinding[] = [
    { id: "f1", agent: "rev", phase: "review", iteration: 1, file: "a.ts", line_start: 3, line_end: null, severity: "blocking", category: "logic", summary: "x", status: "open", recorded_at: "t" },
    { id: "f2", agent: "other", phase: "review", iteration: 1, file: null, line_start: null, line_end: null, severity: "info", category: "style", summary: "y", status: "open", recorded_at: "t" },
  ];
  const verdicts: TraceVerdict[] = [
    { phase: "review", agent: "rev", iteration: 1, verdict: "reject", summary_line: null, blocking_issues: 1, warn_issues: 0, info_issues: 0, recorded_at: "t" },
  ];
  it("filters by the generic agent + phase columns", () => {
    assert.deepEqual(findingsForAgent(findings, "rev", "review").map((f) => f.id), ["f1"]);
    assert.deepEqual(findingsForAgent(findings, "rev", "other-phase"), []);
    assert.equal(verdictsForAgent(verdicts, "rev", "review").length, 1);
    assert.equal(verdictsForAgent(verdicts, "rev", "elsewhere").length, 0);
  });
});

describe("tokenSummary / compact", () => {
  it("compacts thousands and millions", () => {
    assert.equal(compact(500), "500");
    assert.equal(compact(1234), "1.2k");
    assert.equal(compact(2_500_000), "2.5M");
  });
  it("renders only the token fields that are present + positive", () => {
    assert.equal(
      tokenSummary(agent({ agent_run_id: "r", recorded_at: "t", tokens_in: 12_300, tokens_out: 4_500, tokens_cached: 0 })),
      "12.3k in · 4.5k out",
    );
    assert.equal(tokenSummary(agent({ agent_run_id: "r", recorded_at: "t" })), "");
  });
});
