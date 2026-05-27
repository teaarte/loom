// NowToken — replay-safe wall-clock token.
//
// Branded ISO-8601 UTC string. Captured ONCE per FSM tick outside the
// SQLite transaction, threaded through every kernel call, and persisted
// onto the idempotency-ledger row so replay returns the SAME value.
// Deterministic comparisons (spawn-window, zombie-window, bypass-marker
// expiry, ledger TTL, past-misses lookback) MUST use this — never
// `Date.now()` / `new Date()`. The branding makes accidental
// substitution a type error.

export type NowToken = string & { readonly __brand: "NowToken" };
