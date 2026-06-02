// Generic retry policy for the supervisor — by COUNT and TIME, never by
// domain. The supervisor classifies a terminal `drive()` error solely by its
// error CODE (transport/kernel vocabulary), decides transient-vs-terminal,
// and on a transient code re-`drive()`s after an exponential, capped backoff
// until a ceiling of attempts is reached. Nothing here reads a bundle's
// meaning — it is the same "generic, by count/time" enforcement the driver
// loop applies to a fanout, lifted to the whole-task retry.

export interface RetryPolicy {
  // Maximum transient re-drives for ONE logical task before the supervisor
  // gives up and escalates the error.
  max_attempts: number;
  // First backoff delay; each subsequent attempt multiplies by `factor`.
  base_delay_ms: number;
  factor: number;
  // Upper bound on a single backoff delay.
  ceiling_ms: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  max_attempts: 5,
  base_delay_ms: 1_000,
  factor: 2,
  ceiling_ms: 60_000,
};

export type ErrorDisposition = "transient" | "terminal";

// How an error CODE is classified. Pure over the code string — a transport
// vocabulary, not a domain one. A caller can override for its own backend's
// codes; the default treats the executor/transport blips as transient and
// everything structural (budget, invariant, no-task, deliberate abort) as
// terminal — escalate rather than spin.
export type ErrorClassifier = (code: string) => ErrorDisposition;

// Codes worth a backoff re-drive: a dropped/hung backend round-trip. These
// are the failures that a later attempt can legitimately clear (a network
// blip, a transiently unavailable runner). `drive()` already does its own
// fast in-loop executor retry (`max_executor_retries`); this is the slower
// tier ABOVE it, for a failure that outlived the fast retries.
const TRANSIENT_CODES = new Set<string>(["EXECUTOR_FAILED", "EXECUTOR_NOT_FOUND"]);

export const defaultClassifier: ErrorClassifier = (code: string): ErrorDisposition => {
  // Everything not explicitly transient escalates: a structural error
  // (SPAWN_BUDGET_EXCEEDED, KERNEL_INVARIANT, NO_ACTIVE_TASK, FLOW_OVERFLOW)
  // or a deliberate shutdown (DRIVE_ABORTED) will not clear by retrying, so
  // surface it rather than loop.
  return TRANSIENT_CODES.has(code) ? "transient" : "terminal";
};

// The capped exponential backoff for the Nth transient attempt (attempt is
// 1-based: the first retry waits `base_delay_ms`).
export function backoffDelayMs(policy: RetryPolicy, attempt: number): number {
  if (attempt <= 1) return Math.min(policy.base_delay_ms, policy.ceiling_ms);
  const raw = policy.base_delay_ms * Math.pow(policy.factor, attempt - 1);
  return Math.min(Math.round(raw), policy.ceiling_ms);
}
