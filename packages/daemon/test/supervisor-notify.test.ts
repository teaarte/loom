// The supervisor fires outbound notifications on the same lifecycle transitions
// it logs — over a REAL store, with an in-memory notifier asserting the event
// stream. Proves the three default signals (complete / parked / failed) carry
// the right generic fields, and that a THROWING sink never breaks the loop (the
// best-effort boundary downgrades it to a logged `notify-failed` warning).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deliverAndAdvance, readState, type Executor } from "@loomfsm/driver";

import {
  createMemoryLogger,
  createMemoryNotifier,
  superviseToTerminal,
  type Clock,
  type Notifier,
  type RetryPolicy,
} from "../src/index.js";
import { cleanup, FIXED_NOW, freshProject, gateRegistry, recordingExecutor, spawnRegistry } from "./fixtures.js";

const FIXED_MS = Date.parse(FIXED_NOW);
const immediateClock: Clock = { now: () => FIXED_MS, sleep: async () => {} };
const FAST_RETRY: RetryPolicy = { max_attempts: 2, base_delay_ms: 1, factor: 2, ceiling_ms: 5 };

describe("supervisor notify — complete", () => {
  it("fires a complete event with the verdict and a transport ts", async () => {
    const dir = await freshProject();
    try {
      const notifier = createMemoryNotifier();
      const result = await superviseToTerminal(dir, {
        buildExecutor: () => recordingExecutor([]),
        resolveRegistry: () => spawnRegistry(),
        task: "do the work",
        clock: immediateClock,
        notifier,
      });
      assert.equal(result.kind, "complete");
      const completes = notifier.events.filter((e) => e.event === "complete");
      assert.equal(completes.length, 1);
      assert.equal(completes[0]?.verdict, "accepted");
      assert.equal(completes[0]?.ts, FIXED_NOW);
      assert.ok(completes[0]?.task_id);
    } finally {
      cleanup(dir);
    }
  });
});

describe("supervisor notify — parked", () => {
  it("fires a parked event with the gate before waiting, then complete", async () => {
    const dir = await freshProject();
    try {
      const registry = gateRegistry();
      const notifier = createMemoryNotifier();
      // The wake-poll sleep stands in for the human answering the gate.
      const wakingClock: Clock = {
        now: () => FIXED_MS,
        sleep: async () => {
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

      const result = await superviseToTerminal(dir, {
        buildExecutor: () => ({ execute: async () => ({ agent_output: "" }) }),
        resolveRegistry: () => registry,
        task: "gated work",
        clock: wakingClock,
        notifier,
      });

      assert.equal(result.kind, "complete");
      const parked = notifier.events.filter((e) => e.event === "parked");
      assert.equal(parked.length, 1);
      assert.equal(typeof parked[0]?.gate, "string");
      assert.ok((parked[0]?.gate ?? "").length > 0);
      // The full leg still reached complete afterwards.
      assert.ok(notifier.events.some((e) => e.event === "complete"));
    } finally {
      cleanup(dir);
    }
  });
});

describe("supervisor notify — failed", () => {
  it("fires a failed event with the error code at the retry ceiling", async () => {
    const dir = await freshProject();
    try {
      const notifier = createMemoryNotifier();
      const alwaysFails: Executor = {
        execute: async () => {
          throw new Error("backend down");
        },
      };
      const result = await superviseToTerminal(dir, {
        buildExecutor: () => alwaysFails,
        resolveRegistry: () => spawnRegistry(),
        task: "doomed work",
        clock: immediateClock,
        retry_policy: FAST_RETRY,
        notifier,
      });
      assert.equal(result.kind, "error");
      const failed = notifier.events.filter((e) => e.event === "failed");
      assert.equal(failed.length, 1);
      assert.equal(failed[0]?.code, "EXECUTOR_FAILED");
      // The opt-in retry signals also fired along the way (the notifier sees
      // everything; the allowlist filter, applied by config, is what gates them).
      assert.ok(notifier.events.some((e) => e.event === "retry"));
    } finally {
      cleanup(dir);
    }
  });
});

describe("supervisor notify — best-effort boundary", () => {
  it("a throwing sink never breaks the loop; it is logged as notify-failed", async () => {
    const dir = await freshProject();
    try {
      const logger = createMemoryLogger();
      const throwing: Notifier = {
        notify: async () => {
          throw new Error("sink boom");
        },
      };
      const result = await superviseToTerminal(dir, {
        buildExecutor: () => recordingExecutor([]),
        resolveRegistry: () => spawnRegistry(),
        task: "do the work",
        clock: immediateClock,
        notifier: throwing,
        logger,
      });
      assert.equal(result.kind, "complete"); // the sink throw did NOT abort the run
      const warned = logger.events.filter((e) => e.event === "notify-failed");
      assert.ok(warned.length >= 1);
      assert.equal(warned[0]?.detail?.["event"], "complete");
    } finally {
      cleanup(dir);
    }
  });
});
