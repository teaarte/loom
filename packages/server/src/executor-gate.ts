// Wrap an `Executor` so each spawn acquires a shared semaphore permit before
// it runs — the fleet-wide concurrency cap.
//
// This is a pure transport decorator: it sits BETWEEN the supervisor and the
// real backend executor and changes nothing about a spawn except WHEN it gets
// to run. The kernel and the driver loop are untouched; the `drive()` loop
// still bounds a single project's fanout by its stage's declared
// `max_concurrent_spawns`, and this gate bounds the SUM across every project
// the control plane supervises. It reasons only about a permit count — no
// domain meaning, no `agent_run_id` minting (it passes the kernel's intent
// through verbatim).

import type { Executor, ExecutorResult } from "@loomfsm/driver";
import type { ProviderShuttleIntent } from "@loomfsm/kernel";

import type { Semaphore } from "./semaphore.js";

// Decorate `inner` so every `execute` runs inside one permit of `gate`.
// The decorator changes only WHEN a spawn runs, so it forwards `inner`'s
// re-execution-safety verbatim — otherwise wrapping a sandboxed executor would
// silently re-arm the provider idempotency gate and break resume/recovery.
export function gatedExecutor(inner: Executor, gate: Semaphore): Executor {
  return {
    ...(inner.idempotent !== undefined ? { idempotent: inner.idempotent } : {}),
    execute(spawn: ProviderShuttleIntent): Promise<ExecutorResult> {
      return gate.run(() => inner.execute(spawn));
    },
  };
}
