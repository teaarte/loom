// Typed ID minting + locked regex patterns.
//
// This is the ONE module in the kernel where ambient wall-clock access
// is permitted — mint time only. Everywhere else, timestamps thread
// through as NowToken values so replay is bit-identical. Generators
// accept an optional NowToken so test harnesses and replay paths can
// inject a stable clock; the parameter falls back to `new Date()` when
// absent, so caller code never has to touch the clock manually.

import { randomUUID } from "node:crypto";

import type { NowToken } from "./types/now.js";

// ============================================================================
// Locked regex patterns
// ============================================================================

// Task identifier: t-YYYY-MM-DD-<slug>[-hash4]
export const TASK_ID_PATTERN = /^t-\d{4}-\d{2}-\d{2}-[a-z0-9]+(-[a-f0-9]{4})?$/;

// Agent run identifier: ar-<uuid>
export const AGENT_RUN_ID_PATTERN =
  /^ar-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Finding identifier: f-YYYY-MM-DD-<random6>
export const FINDING_ID_PATTERN = /^f-\d{4}-\d{2}-\d{2}-[a-z0-9]{6}$/;

// Driver state identifier: d-<uuid>
export const DRIVER_STATE_ID_PATTERN =
  /^d-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Gate event identifier: gev-<uuid>
export const GATE_EVENT_ID_PATTERN =
  /^gev-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Recovery action identifier: rec-<uuid>. Server-issued: the recover
// handler mints one on the first call and returns it; a retried call
// passes it back to key the idempotency-ledger replay, while omitting it
// issues a fresh recovery action. Closes the transport-flake-double-
// recover hole (a retried network call must not double-apply a recovery).
export const RECOVERY_ID_PATTERN =
  /^rec-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ============================================================================
// Internal helpers
// ============================================================================

function isoDate(now?: NowToken): string {
  // NowToken is an ISO-8601 string by construction (see types.ts).
  // Replay paths thread it through; mint-time fallback reads the wall
  // clock directly — the only place this is allowed.
  const iso = now ?? (new Date().toISOString() as NowToken); // allow-ambient-clock: mint-time fallback for ID generators (documented exception in types/now.ts)
  // Slice the YYYY-MM-DD prefix. ISO format guarantees `[10]` is "T".
  return iso.slice(0, 10);
}

// Random uuid → first N hex chars. randomUUID is `8-4-4-4-12`; we strip
// hyphens before slicing so callers always receive a contiguous run.
function randHex(n: number): string {
  return randomUUID().replace(/-/g, "").slice(0, n);
}

function sanitizeSlug(input: string): string {
  const cleaned = input.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return cleaned.length > 0 ? cleaned : "task";
}

// ============================================================================
// Generators
// ============================================================================

// Task id. Slug is lowercased + non-alphanumeric stripped; the optional
// hash suffix is reserved for caller-side collision resolution against
// the on-disk task index.
export function makeTaskId(slug: string, now?: NowToken): string {
  return `t-${isoDate(now)}-${sanitizeSlug(slug)}`;
}

// Explicit collision-resolution variant. Appends a 4-char hex hash
// drawn from a fresh uuid so two same-day, same-slug tasks differ.
export function makeTaskIdWithHash(slug: string, now?: NowToken): string {
  return `t-${isoDate(now)}-${sanitizeSlug(slug)}-${randHex(4)}`;
}

export function makeAgentRunId(): string {
  return `ar-${randomUUID()}`;
}

export function makeFindingId(now?: NowToken): string {
  // Six lowercase alphanumerics. Pulling from randomUUID gives hex
  // (subset of [a-z0-9]) — matches FINDING_ID_PATTERN's character class.
  return `f-${isoDate(now)}-${randHex(6)}`;
}

export function makeDriverStateId(): string {
  return `d-${randomUUID()}`;
}

export function makeGateEventId(): string {
  return `gev-${randomUUID()}`;
}

export function makeRecoveryId(): string {
  return `rec-${randomUUID()}`;
}
