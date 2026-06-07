// Park-and-wake — `waitForWake` over a REAL store. A parked gate is woken
// only when a human's answer is delivered through the ordinary continue path
// (the supervisor observes the generic pending-answer slot clear); a shutdown
// signal aborts the wait. The clock is injected so the poll runs without real
// waits, and the "human" answers inside the poll's sleep.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAndStart, deliverAndAdvance, readState } from "@loomfsm/driver";

import { type Clock, waitForWake } from "../src/index.js";
import { cleanup, FIXED_NOW, freshProject, gateRegistry } from "./fixtures.js";

describe("wake — waitForWake", () => {
  it("wakes when the parked gate's answer is delivered", async () => {
    const dir = await freshProject();
    try {
      const registry = gateRegistry();
      const created = await createAndStart(dir, {
        registry,
        task: "gated work",
        client_idempotency_uuid: "cidem-wake",
      });
      assert.equal(created.response.status, "ask-user");
      if (created.response.status !== "ask-user") throw new Error("expected ask-user");
      const gateEventId = created.response.gate_event_id;

      // A clock whose sleep stands in for "the human answered" — it delivers
      // the accept through the ordinary continue path, exactly as `/proceed`
      // would, advancing past the gate.
      let polls = 0;
      const wakingClock: Clock = {
        now: () => Date.parse(FIXED_NOW),
        sleep: async () => {
          polls += 1;
          const st = await readState(dir);
          const pa = st.driver.pending_user_answer;
          if (pa !== null) {
            await deliverAndAdvance(dir, {
              registry,
              input: { type: "user-answer", gate_event_id: pa.gate_event_id, decision: "accept" },
              driver_state_id: st.driver_state_id,
            });
          }
        },
      };

      const result = await waitForWake(dir, gateEventId, { clock: wakingClock });
      assert.equal(result, "woken");
      assert.equal(polls, 1);
      // The gate's pending answer is gone — the task advanced past it.
      assert.equal((await readState(dir)).driver.pending_user_answer, null);
    } finally {
      cleanup(dir);
    }
  });

  it("aborts the wait on a shutdown signal without delivering anything", async () => {
    const dir = await freshProject();
    try {
      const registry = gateRegistry();
      const created = await createAndStart(dir, {
        registry,
        task: "gated work",
        client_idempotency_uuid: "cidem-wake-abort",
      });
      if (created.response.status !== "ask-user") throw new Error("expected ask-user");
      const gateEventId = created.response.gate_event_id;

      const controller = new AbortController();
      controller.abort();
      const neverClock: Clock = {
        now: () => Date.parse(FIXED_NOW),
        sleep: async () => assert.fail("must not sleep — the abort short-circuits"),
      };

      const result = await waitForWake(dir, gateEventId, {
        clock: neverClock,
        signal: controller.signal,
      });
      assert.equal(result, "aborted");
      // Still parked — nothing was answered.
      assert.notEqual((await readState(dir)).driver.pending_user_answer, null);
    } finally {
      cleanup(dir);
    }
  });
});
