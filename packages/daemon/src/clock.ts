// An injectable wall clock for the supervisor's time-shaped decisions —
// backoff delays, poll intervals, pending-row ageing, and log timestamps.
//
// The daemon is a TRANSPORT, outside the kernel's replay graph, so an
// ambient clock is allowed here (the same posture `loom status` takes when
// it ages pending rows host-side). It is injectable so a test pins a
// deterministic clock and drives the backoff/wake/staleness logic without
// real waits.

// The abort-aware sleep so a graceful shutdown (SIGTERM/SIGINT) interrupts a
// backoff or a wake-poll immediately rather than blocking for the full delay.
export interface Clock {
  // Milliseconds since the epoch.
  now(): number;
  // Resolve after `ms`, or early when `signal` aborts (never rejects — the
  // caller re-checks `signal.aborted` after awaiting).
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now(): number {
    return Date.now();
  },
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        cleanup();
        resolve();
      };
      const cleanup = (): void => {
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
};

// ISO-8601 stamp from a clock reading. `new Date(ms)` takes an explicit
// argument (never the argless wall-clock form the kernel forbids), and this
// is transport code anyway.
export function isoFrom(clock: Clock): string {
  return new Date(clock.now()).toISOString();
}
