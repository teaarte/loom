import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { narrowStateForBundle } from "../src/narrow.js";
import type { NowToken } from "../src/types/now.js";
import type { PolicyName } from "../src/types/policy.js";
import type { GateRole } from "../src/types/row-types.js";
import type { PipelineState } from "../src/types/state.js";

// Fully populated PipelineState — every field set to a recognizable
// value so a missed key in the projection lights up as a deep-equal
// miss instead of slipping through under default `undefined`.
function fullPipelineState(): PipelineState {
  return {
    schema_version: "3.0.0",
    task_id: "t-2026-05-28-x",
    driver_state_id: "d-fixture",
    project_dir: "/tmp/fixture",
    bundle: "code",
    task: "build a thing",
    task_short: "rich",
    owner_id: "alice",
    status: "in_progress",
    verdict: null,
    started_at: "2026-05-28T11:00:00.000Z" as NowToken,
    ended_at: null,
    gate_policies: {} as Record<GateRole, PolicyName>,
    decisions: { complexity: "medium" },
    bundle_state: { extra: 1 },
    pipeline_violation: null,
    force_used: false,
    agents_count: 3,
    gate_revisions: {} as Record<GateRole, number>,
    gate_auto_rejections: {} as Record<GateRole, number>,
    files_created: ["src/a.ts"],
    files_modified: ["src/b.ts"],
    total_tokens_in: 100,
    total_tokens_out: 50,
    total_tokens_cached: 10,
    driver: {
      flow_name: "simple",
      step_index: 4,
      complete: false,
      pending_user_answer: null,
      scratch: { iter: 1 },
    },
    phases: [],
    gates: {},
    agent_verdicts: [],
    pending_agents: [],
    now: "2026-05-28T12:00:00.000Z" as NowToken,
  };
}

describe("narrowStateForBundle", () => {
  it("strips driver and schema_version from the projection", () => {
    const state = fullPipelineState();
    const now = "2026-05-28T12:00:00.000Z" as NowToken;
    const view = narrowStateForBundle(state, now);

    // The two fields the projection MUST hide. A bundle plugin
    // depending on `driver.*` or `schema_version` is the failure
    // mode this projection exists to prevent.
    assert.equal((view as unknown as { driver?: unknown }).driver, undefined);
    assert.equal(
      (view as unknown as { schema_version?: unknown }).schema_version,
      undefined,
    );
  });

  it("preserves every BundleStateView field unchanged", () => {
    const state = fullPipelineState();
    const now = "2026-05-28T12:00:00.000Z" as NowToken;
    const view = narrowStateForBundle(state, now);

    // Every field listed in BundleStateView must round-trip
    // identically. If a field is added to the interface and the
    // narrow body forgets to copy it, this assertion lights up.
    assert.equal(view.task_id, state.task_id);
    assert.equal(view.driver_state_id, state.driver_state_id);
    assert.equal(view.project_dir, state.project_dir);
    assert.equal(view.bundle, state.bundle);
    assert.equal(view.task, state.task);
    assert.equal(view.task_short, state.task_short);
    assert.equal(view.owner_id, state.owner_id);
    assert.equal(view.status, state.status);
    assert.equal(view.verdict, state.verdict);
    assert.equal(view.started_at, state.started_at);
    assert.equal(view.ended_at, state.ended_at);
    assert.equal(view.gate_policies, state.gate_policies);
    assert.equal(view.decisions, state.decisions);
    assert.equal(view.bundle_state, state.bundle_state);
    assert.equal(view.pipeline_violation, state.pipeline_violation);
    assert.equal(view.force_used, state.force_used);
    assert.equal(view.agents_count, state.agents_count);
    assert.equal(view.gate_revisions, state.gate_revisions);
    assert.equal(view.gate_auto_rejections, state.gate_auto_rejections);
    assert.equal(view.files_created, state.files_created);
    assert.equal(view.files_modified, state.files_modified);
    assert.equal(view.total_tokens_in, state.total_tokens_in);
    assert.equal(view.total_tokens_out, state.total_tokens_out);
    assert.equal(view.total_tokens_cached, state.total_tokens_cached);
    assert.equal(view.phases, state.phases);
    assert.equal(view.gates, state.gates);
    assert.equal(view.agent_verdicts, state.agent_verdicts);
    assert.equal(view.pending_agents, state.pending_agents);
  });

  it("uses the passed-in NowToken (not state.now)", () => {
    // The projection threads `now` from the FSM tick rather than
    // copying `state.now`. The two are usually identical, but
    // diagnostic / read-only paths may build a state from a
    // stored row whose own `now` is stale; the projection must
    // reflect the live tick.
    const state = fullPipelineState();
    const liveNow = "2026-12-31T23:59:59.000Z" as NowToken;
    const view = narrowStateForBundle(state, liveNow);
    assert.equal(view.now, liveNow);
    assert.notEqual(view.now, state.now);
  });

  it("freezes the top-level projection (mutation throws in strict mode)", () => {
    const state = fullPipelineState();
    const view = narrowStateForBundle(state, state.now);
    assert.equal(Object.isFrozen(view), true);
    assert.throws(() => {
      (view as unknown as { task: string }).task = "tampered";
    }, /read only|read-only|extensible|object is not extensible|Cannot assign/i);
  });
});
