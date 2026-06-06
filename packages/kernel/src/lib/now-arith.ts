// NowToken arithmetic — the ONE place a `NowToken` is shifted by a fixed
// offset.
//
// A `NowToken` is a captured wall-clock value threaded through the FSM tick; it
// is never re-read from the host. But several call sites need a token a fixed
// number of milliseconds before/after a captured one — a spawn-duplicate window
// cutoff, a zombie-pending threshold, a ledger TTL, a bypass-marker expiry. Each
// used to carry its own `new Date(epoch ± ms).toISOString()` line plus an
// `allow-ambient-clock` marker, scattering the load-bearing exception. This is
// the single home: `offsetNowToken(now, ms)` parses the SUPPLIED token string
// (`Date.parse`, deterministic on a stable input) and re-serializes it shifted
// by `ms` (negative shifts earlier). It never reads `Date.now()` / an argless
// `new Date()`, so it is replay-safe — the same token + offset yields the same
// result on the original commit and every replay. The single `allow-ambient-
// clock` marker below is the only NowToken-arithmetic exception the lint sees.

import type { NowToken } from "../types/now.js";

// Shift a NowToken by `ms` milliseconds (negative → earlier). Pure over the
// supplied token; no host-clock read.
export function offsetNowToken(now: NowToken, ms: number): NowToken {
  const epoch = Date.parse(now);
  return new Date(epoch + ms).toISOString() as NowToken; // allow-ambient-clock: parses the supplied NowToken string only; never reads the host clock
}
