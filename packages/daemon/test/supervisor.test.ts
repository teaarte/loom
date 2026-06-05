// The supervisor — the long-lived loop over `drive()` — against a REAL
// SQLite store + REAL git, with the backend stubbed. Proves the four things
// `loom run` cannot do: complete with merge-back, park-and-wake on a human
// gate, retry/backoff a transient failure (and escalate at the ceiling), and
// recover a killed in-flight task on restart. No mocked DB; reverting the
// behaviour under test reddens.

import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createAndStart,
  createSandboxedExecutor,
  deliverAndAdvance,
  readState,
  type Executor,
} from "@loomfsm/driver";
import { KernelError, type ProviderShuttleIntent } from "@loomfsm/kernel";

import {
  detectStaleness,
  superviseToTerminal,
  superviseWatch,
  type Clock,
  type RetryPolicy,
} from "../src/index.js";
import {
  cleanup,
  FIXED_NOW,
  freshGitProject,
  freshProject,
  gateRegistry,
  recordingExecutor,
  singleSpawnRegistry,
  spawnRegistry,
} from "./fixtures.js";

const FIXED_MS = Date.parse(FIXED_NOW);
const immediateClock: Clock = { now: () => FIXED_MS, sleep: async () => {} };
const FAST_RETRY: RetryPolicy = { max_attempts: 2, base_delay_ms: 1, factor: 2, ceiling_ms: 5 };

function git(cwd: string, ...args: string[]): boolean {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).status === 0;
}

describe("supervisor — drives a task to complete", () => {
  it("runs the spawn flow to complete (non-git → merge-back no-op)", async () => {
    const dir = await freshProject();
    try {
      const seen: string[] = [];
      const registry = spawnRegistry();
      const result = await superviseToTerminal(dir, {
        buildExecutor: () => recordingExecutor(seen),
        resolveRegistry: () => registry,
        task: "do the work",
        clock: immediateClock,
      });
      assert.equal(result.kind, "complete");
      if (result.kind === "complete") {
        assert.equal(result.verdict, "accepted");
        assert.equal(result.merge_back.merged, false);
        assert.equal(result.merge_back.reason, "no-worktree");
      }
      assert.equal(seen.length, 2); // both spawns ran, each once
      assert.equal((await readState(dir)).status, "completed");
    } finally {
      cleanup(dir);
    }
  });
});

describe("supervisor — merge-back commits to loom/<task> (real git)", () => {
  it("commits the worktree to a branch and GCs it on complete", async () => {
    const dir = await freshGitProject();
    try {
      const registry = singleSpawnRegistry();
      const buildExecutor = (ctx: { onNotice: (m: string) => void; signal: AbortSignal }): Executor =>
        createSandboxedExecutor({
          project_dir: dir,
          runSpawn: async (_intent: ProviderShuttleIntent, worktreeDir: string) => {
            writeFileSync(join(worktreeDir, "generated.ts"), "export const x = 1;\n", "utf8");
            return "implemented";
          },
          onNotice: ctx.onNotice,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        });

      const result = await superviseToTerminal(dir, {
        buildExecutor,
        resolveRegistry: () => registry,
        task: "build the thing",
        clock: immediateClock,
      });

      assert.equal(result.kind, "complete");
      if (result.kind !== "complete") throw new Error("expected complete");
      assert.equal(result.merge_back.merged, true);
      const taskId = result.task_id;
      assert.ok(taskId !== null);
      assert.equal(result.merge_back.branch, `loom/${taskId}`);
      assert.ok(result.merge_back.files_changed?.includes("generated.ts"));
      // The branch carries the work; the main tree was never touched; the
      // worktree was GC'd but its branch survives.
      assert.ok(git(dir, "rev-parse", "--verify", `loom/${taskId}`));
      assert.equal(existsSync(join(dir, "generated.ts")), false);
      assert.equal(result.merge_back.worktree_removed, true);
    } finally {
      cleanup(dir);
    }
  });
});

describe("supervisor — parks on a human gate and wakes on the answer", () => {
  it("never auto-answers; a delivered answer resumes it to complete", async () => {
    const dir = await freshProject();
    try {
      const registry = gateRegistry();
      let executed = 0;
      // The clock's sleep stands in for the human answering during the wake
      // poll — delivered through the ordinary continue path.
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
        buildExecutor: () => ({
          execute: async () => {
            executed += 1;
            return { agent_output: "" };
          },
        }),
        resolveRegistry: () => registry,
        task: "gated work",
        clock: wakingClock,
      });

      assert.equal(result.kind, "complete");
      assert.equal(executed, 0, "a human gate must never auto-run a spawn");
      assert.equal((await readState(dir)).status, "completed");
    } finally {
      cleanup(dir);
    }
  });
});

describe("supervisor — retry / backoff (generic, by code + time)", () => {
  it("retries a transient EXECUTOR_FAILED then drives to complete", async () => {
    const dir = await freshProject();
    try {
      const registry = spawnRegistry();
      // Throw on the first three execute calls (drive's own in-loop retries
      // exhaust → it returns EXECUTOR_FAILED), then succeed on the
      // supervisor's re-drive.
      let calls = 0;
      const seen: string[] = [];
      const flaky: Executor = {
        execute: async (s: ProviderShuttleIntent) => {
          calls += 1;
          if (calls <= 3) throw new Error("simulated dropped backend");
          seen.push(s.agent_run_id);
          return { agent_output: `done ${s.agent}` };
        },
      };
      const result = await superviseToTerminal(dir, {
        buildExecutor: () => flaky,
        resolveRegistry: () => registry,
        task: "flaky work",
        clock: immediateClock,
        retry_policy: FAST_RETRY,
      });
      assert.equal(result.kind, "complete");
      if (result.kind === "complete") assert.equal(result.attempts, 1);
      assert.ok(calls > 3, "the supervisor must have re-driven after the failure");
      assert.equal((await readState(dir)).status, "completed");
    } finally {
      cleanup(dir);
    }
  });

  it("escalates a persistent transient failure at the retry ceiling", async () => {
    const dir = await freshProject();
    try {
      const registry = spawnRegistry();
      const alwaysFails: Executor = {
        execute: async () => {
          throw new Error("backend down");
        },
      };
      const result = await superviseToTerminal(dir, {
        buildExecutor: () => alwaysFails,
        resolveRegistry: () => registry,
        task: "doomed work",
        clock: immediateClock,
        retry_policy: FAST_RETRY,
      });
      assert.equal(result.kind, "error");
      if (result.kind === "error") {
        assert.equal(result.code, "EXECUTOR_FAILED");
        // max_attempts re-drives, then one more drive trips the ceiling.
        assert.equal(result.attempts, FAST_RETRY.max_attempts + 1);
      }
    } finally {
      cleanup(dir);
    }
  });
});

describe("supervisor — a thrown drive surfaces as a parked error, never a crash", () => {
  it("normalizes a kernel throw (e.g. an INVARIANT_VIOLATION) to a terminal error outcome", async () => {
    const dir = await freshProject();
    try {
      // `drive()` resolves the registry at the top of the tick; a throw there
      // stands in for any kernel throw that escapes a delivery/finalize tx —
      // the INVARIANT_VIOLATION on the post-gate finalize that used to unwind
      // the whole watch loop and wedge the slot at `in_progress`.
      const result = await superviseToTerminal(dir, {
        buildExecutor: () => recordingExecutor([]),
        resolveRegistry: () => {
          throw new KernelError({ code: "INVARIANT_VIOLATION", message: "phase not terminal" });
        },
        task: "wedging work",
        clock: immediateClock,
        retry_policy: FAST_RETRY,
      });
      // It RETURNS an error (terminal → escalated at once), it does NOT throw.
      assert.equal(result.kind, "error");
      if (result.kind === "error") {
        assert.equal(result.code, "INVARIANT_VIOLATION");
        assert.equal(result.attempts, 0); // terminal → no transient retries burned
      }
    } finally {
      cleanup(dir);
    }
  });

  it("normalizes an unexpected (non-kernel) throw to DRIVE_CRASHED", async () => {
    const dir = await freshProject();
    try {
      const result = await superviseToTerminal(dir, {
        buildExecutor: () => recordingExecutor([]),
        resolveRegistry: () => {
          throw new Error("something exploded outside the kernel");
        },
        task: "crashing work",
        clock: immediateClock,
        retry_policy: FAST_RETRY,
      });
      assert.equal(result.kind, "error");
      if (result.kind === "error") assert.equal(result.code, "DRIVE_CRASHED");
    } finally {
      cleanup(dir);
    }
  });
});

describe("supervisor — rate-limit-aware wait (a time class, not a retry)", () => {
  it("waits out a rate-limit then re-drives, NOT against the retry ceiling", async () => {
    const dir = await freshProject();
    try {
      const registry = singleSpawnRegistry();
      let calls = 0;
      let waited = 0;
      // The wait sleep is recorded; everything else runs at the fixed instant.
      const waitClock: Clock = {
        now: () => FIXED_MS,
        sleep: async () => {
          waited += 1;
        },
      };
      const rateLimitedOnce: Executor = {
        execute: async (s: ProviderShuttleIntent) => {
          calls += 1;
          if (calls === 1) {
            throw new KernelError({ code: "EXECUTOR_RATE_LIMITED", message: "rate limited" });
          }
          return { agent_output: `done ${s.agent}` };
        },
      };

      const result = await superviseToTerminal(dir, {
        buildExecutor: () => rateLimitedOnce,
        resolveRegistry: () => registry,
        task: "rate-limited work",
        clock: waitClock,
        retry_policy: FAST_RETRY,
        rate_limit_wait_ms: 9_999,
      });

      assert.equal(result.kind, "complete");
      // The wait is NOT a transient retry — the ceiling budget is untouched.
      if (result.kind === "complete") assert.equal(result.attempts, 0);
      assert.ok(waited >= 1, "the supervisor must have waited out the rate-limit");
      assert.ok(calls >= 2, "it must have re-driven after the wait");
      assert.equal((await readState(dir)).status, "completed");
    } finally {
      cleanup(dir);
    }
  });

  it("returns aborted when the shutdown signal fires during the rate-limit wait", async () => {
    const dir = await freshProject();
    try {
      const registry = singleSpawnRegistry();
      const controller = new AbortController();
      const alwaysRateLimited: Executor = {
        execute: async () => {
          throw new KernelError({ code: "EXECUTOR_RATE_LIMITED", message: "rate limited" });
        },
      };
      // The shutdown lands during the wait: abort inside the sleep, mirroring
      // the abort-aware clock's early return.
      const abortingClock: Clock = {
        now: () => FIXED_MS,
        sleep: async () => {
          controller.abort();
        },
      };

      const result = await superviseToTerminal(dir, {
        buildExecutor: () => alwaysRateLimited,
        resolveRegistry: () => registry,
        task: "rate-limited work",
        clock: abortingClock,
        rate_limit_wait_ms: 9_999,
        signal: controller.signal,
      });

      assert.equal(result.kind, "aborted");
    } finally {
      cleanup(dir);
    }
  });
});

describe("supervisor — watch does not tight-loop on a persistent failure", () => {
  it("cools down after each escalation, then parks the wedged slot (stops re-driving)", async () => {
    const dir = await freshProject();
    try {
      const registry = spawnRegistry();
      // Seed an in-progress task so every watch iteration takes the in_progress
      // branch (no first-iteration seed leg to reason about).
      await createAndStart(dir, {
        registry,
        task: "doomed work",
        client_idempotency_uuid: "cidem-park",
      });

      const controller = new AbortController();
      let builds = 0;
      let sleeps = 0;
      const STOP_AFTER_SLEEPS = 25;
      // Records sleeps and stops the watch once it is clearly idle-polling.
      const countingClock: Clock = {
        now: () => FIXED_MS,
        sleep: async () => {
          sleeps += 1;
          if (sleeps >= STOP_AFTER_SLEEPS) controller.abort();
        },
      };
      const alwaysFails: Executor = {
        execute: async () => {
          throw new Error("backend down");
        },
      };

      await superviseWatch(dir, {
        buildExecutor: () => {
          builds += 1;
          return alwaysFails;
        },
        resolveRegistry: () => registry,
        clock: countingClock,
        retry_policy: FAST_RETRY, // max_attempts 2 → 3 drives (builds) per superviseToTerminal
        watch_error_park_after: 2, // park after 2 escalations
        signal: controller.signal,
      });

      // Two escalations before parking, 3 builds each = 6; then the slot is
      // PARKED and never re-driven again (the loop idle-polls until abort).
      // Without the fix this loops forever, re-driving on every iteration.
      assert.equal(builds, 6, "the watch parked after 2 escalations and stopped re-driving");
      assert.ok(sleeps >= STOP_AFTER_SLEEPS, "it kept idle-polling rather than tight-looping");
    } finally {
      cleanup(dir);
    }
  });
});

describe("supervisor — recovery on restart", () => {
  it("attaches to a killed in-flight task and finishes it, reusing the agent_run_id", async () => {
    const dir = await freshProject();
    try {
      const registry = spawnRegistry();
      // Simulate a daemon killed mid-spawn: the task exists with spawn-1
      // dispatched (pending) but never delivered.
      const created = await createAndStart(dir, {
        registry,
        task: "interrupted work",
        client_idempotency_uuid: "cidem-recover",
      });
      assert.equal(created.response.status, "spawn-agent");
      if (created.response.status !== "spawn-agent") throw new Error("expected spawn-agent");
      const pendingArid = created.response.agent_run_id;

      // A fresh supervisor with NO task attaches to the active task.
      const seen: string[] = [];
      const result = await superviseToTerminal(dir, {
        buildExecutor: () => recordingExecutor(seen),
        resolveRegistry: () => registry,
        clock: immediateClock,
      });

      assert.equal(result.kind, "complete");
      // The pending spawn was re-shuttled REUSING its agent_run_id (no fresh
      // spawn), and the run completed.
      assert.equal(seen[0], pendingArid);
      const state = await readState(dir);
      assert.equal(state.status, "completed");
      assert.equal(state.agents_count, 2, "no duplicate spawn was minted on recovery");
    } finally {
      cleanup(dir);
    }
  });

  it("is a no-op when there is no active task and none is given", async () => {
    const dir = await freshProject();
    try {
      const result = await superviseToTerminal(dir, {
        buildExecutor: () => recordingExecutor([]),
        resolveRegistry: () => spawnRegistry(),
        clock: immediateClock,
      });
      assert.equal(result.kind, "noop");
      if (result.kind === "noop") assert.equal(result.reason, "no-active-task");
    } finally {
      cleanup(dir);
    }
  });
});

describe("supervisor — graceful shutdown", () => {
  it("returns aborted when the shutdown signal is already set", async () => {
    const dir = await freshProject();
    try {
      const controller = new AbortController();
      controller.abort();
      const result = await superviseToTerminal(dir, {
        buildExecutor: () => recordingExecutor([]),
        resolveRegistry: () => spawnRegistry(),
        task: "work",
        clock: immediateClock,
        signal: controller.signal,
      });
      assert.equal(result.kind, "aborted");
    } finally {
      cleanup(dir);
    }
  });
});

describe("supervisor — staleness detection (by time)", () => {
  it("flags a pending row older than the kernel zombie window", async () => {
    const dir = await freshProject();
    try {
      const registry = spawnRegistry();
      await createAndStart(dir, {
        registry,
        task: "pending work",
        client_idempotency_uuid: "cidem-stale",
      });
      const state = await readState(dir);
      assert.ok(state.pending_agents.length > 0);

      // At task-start time the row is fresh.
      const fresh = detectStaleness(state, { now: () => Date.parse(state.now), sleep: async () => {} });
      assert.equal(fresh.stalled, false);

      // An hour later it is stale.
      const later = Date.parse(state.now) + 60 * 60 * 1000;
      const stale = detectStaleness(state, { now: () => later, sleep: async () => {} });
      assert.equal(stale.stalled, true);
      assert.ok(stale.oldest_age_ms > fresh.oldest_age_ms);
    } finally {
      cleanup(dir);
    }
  });
});
