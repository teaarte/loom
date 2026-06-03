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

// Three dispositions, all by CODE (transport vocabulary), never by domain:
//   transient    — a blip a backoff re-drive can clear; counts against the cap
//   rate-limited — a sustained usage/quota wall that only clears with TIME;
//                  the supervisor WAITS a long fixed duration and re-drives,
//                  NOT counting it against the transient cap (waiting it out is
//                  not the same as failing repeatedly)
//   terminal     — structural / deliberate; escalate rather than spin
export type ErrorDisposition = "transient" | "terminal" | "rate-limited";

// How an error CODE is classified. Pure over the code string — a transport
// vocabulary, not a domain one. A caller can override for its own backend's
// codes; the default treats the executor/transport blips as transient, a
// recognised rate-limit as its own wait class, and everything structural
// (budget, invariant, no-task, deliberate abort) as terminal.
export type ErrorClassifier = (code: string) => ErrorDisposition;

// Codes worth a backoff re-drive: a dropped/hung backend round-trip, or a
// wedged spawn the per-spawn session/idle timeout killed. These are failures a
// later attempt can legitimately clear (a network blip, a transiently
// unavailable runner, a one-off hang). `drive()` already does its own fast
// in-loop executor retry (`max_executor_retries`); this is the slower tier
// ABOVE it, for a failure that outlived the fast retries.
const TRANSIENT_CODES = new Set<string>([
  "EXECUTOR_FAILED",
  "EXECUTOR_NOT_FOUND",
  "EXECUTOR_TIMEOUT",
  "EXECUTOR_IDLE_TIMEOUT",
]);

// Codes that mean "over a usage/rate limit — wait, don't escalate". Distinct
// from transient because the right response is a long fixed wait, not a quick
// backoff that burns the retry budget on a wall time alone clears.
const RATE_LIMITED_CODES = new Set<string>(["EXECUTOR_RATE_LIMITED"]);

export const defaultClassifier: ErrorClassifier = (code: string): ErrorDisposition => {
  if (RATE_LIMITED_CODES.has(code)) return "rate-limited";
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
