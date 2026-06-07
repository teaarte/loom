// Park-and-wake: when `drive()` returns `paused (ask-user)`, the supervisor
// stops driving and WAITS for a human to answer — surviving an arbitrarily
// long gate (the 30-minute laptop-sleep that C1 was born from) without
// burning a turn or auto-answering (a human gate is escalation, never
// machine-resolved).
//
// MVP wake = poll-with-backoff, no new IPC and no kernel surface. The human
// delivers the answer through the EXISTING `/proceed` -> `pipeline_continue_task`
// path, which advances the FSM past the gate; the supervisor observes the
// GENERIC `state.driver.pending_user_answer` slot clear (or move to a
// different gate_event_id) and re-`drive()`s. It reads only that generic
// field — never a gate's domain meaning — so the driver/daemon-leak gate
// stays green. notify / file-watch / HTTP wake are follow-ons.

import { readState } from "@loomfsm/driver";

import { type Clock, systemClock } from "./clock.js";

export interface WakeOptions {
  clock?: Clock;
  // Aborts the wait on graceful shutdown — the poll returns "aborted".
  signal?: AbortSignal;
  // Poll cadence: first wait, growth factor, and steady-state ceiling. A
  // human gate can sit for many minutes, so the cadence backs off to a calm
  // ceiling rather than hammering the store.
  poll_base_ms?: number;
  poll_factor?: number;
  poll_ceiling_ms?: number;
  // Optional hook so the supervisor can log each poll tick.
  onPoll?: (waitedMs: number) => void;
}

export type WakeResult = "woken" | "aborted";

const DEFAULTS = {
  poll_base_ms: 1_000,
  poll_factor: 2,
  poll_ceiling_ms: 15_000,
};

// Block until the answer for `parkedGateEventId` is delivered (the gate's
// pending answer clears or changes), or the signal aborts. Read-only: it
// never mutates state and never delivers the answer itself.
export async function waitForWake(
  projectDir: string,
  parkedGateEventId: string,
  opts: WakeOptions = {},
): Promise<WakeResult> {
  const clock = opts.clock ?? systemClock;
  const base = opts.poll_base_ms ?? DEFAULTS.poll_base_ms;
  const factor = opts.poll_factor ?? DEFAULTS.poll_factor;
  const ceiling = opts.poll_ceiling_ms ?? DEFAULTS.poll_ceiling_ms;

  let tick = 0;
  for (;;) {
    if (opts.signal?.aborted) return "aborted";
    if (await answerDelivered(projectDir, parkedGateEventId)) return "woken";

    const wait = Math.min(Math.round(base * Math.pow(factor, tick)), ceiling);
    opts.onPoll?.(wait);
    await clock.sleep(wait, opts.signal);
    if (opts.signal?.aborted) return "aborted";
    tick += 1;
  }
}

// The answer is "delivered" once the parked gate is no longer the one the
// task waits on: either it cleared (advanced to a spawn / terminal) or the
// flow moved to a different gate (a new gate_event_id). Both mean: re-drive.
async function answerDelivered(projectDir: string, parkedGateEventId: string): Promise<boolean> {
  const state = await readState(projectDir);
  const pending = state.driver.pending_user_answer;
  if (pending === null) return true;
  return pending.gate_event_id !== parkedGateEventId;
}
