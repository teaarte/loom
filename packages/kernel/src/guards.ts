// Precondition guards.
//
// Guards refuse invalid state at the *write* boundary — the operation
// never happens, no rollback work needed because no mutation
// occurred. They co-exist with invariants (which catch already-
// committed-shape violations before commit); the two layers together
// give a defense-in-depth surface: a guard miss surfaces as an
// invariant trip on the next commit, never as silent corruption.
//
// All four guards thread `tx.now` (never `Date.now()` / `new Date()`)
// into their time-window comparisons so a replayed delivery produces
// the same verdict as the original commit. The window cutoff is computed
// with `offsetNowToken` (the single home for NowToken arithmetic), which
// parses the supplied token STRING only — it never reads the host clock.

import { timingSafeEqual } from "node:crypto";

import {
  computeMarkerHmac,
  loadBypassKey,
  reasonEncodesDriver,
} from "./lib/bypass-marker.js";
import { offsetNowToken } from "./lib/now-arith.js";
import { KernelError } from "./state/db.js";
import type { NowToken } from "./types/now.js";
import type { Transaction } from "./types/transaction.js";

// ============================================================================
// Helpers
// ============================================================================

// 5-minute default window. Long enough that two legitimate launches of
// the same agent in the same phase ARE duplicates (operator double-
// click, transport retry); short enough that a legitimate re-fanout
// after recovery is past the window. Defined here (not in a shared
// constants module) so the guard's contract is readable in one file.
export const DEFAULT_SPAWN_DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

// Verify a cross-owner bypass marker and CONSUME it in the same tx as
// the recovery it authorizes — there is no read-then-act window. The
// signing key is loaded from outside state.db and any project dir, so a
// writer that can reach the bypass_markers row still cannot forge a
// valid signature. The single-row marker is deleted on consume; a
// replay after consume surfaces CONSUMED (the signature is valid but no
// live row remains), distinct from a forged marker (bad signature →
// INVALID).
async function verifyOwnerBypassMarker(
  tx: Transaction,
  target: OwnerCheckTarget,
  marker: BypassMarker,
): Promise<void> {
  const key = loadBypassKey();
  if (key === null) {
    throw new KernelError({
      code: "BYPASS_KEY_MISSING",
      message:
        "cross-owner recovery needs a bypass-HMAC key — set PIPELINE_BYPASS_HMAC_KEY or install a user-global ~/.loom/bypass-hmac.key",
    });
  }
  // A marker minted under a now-rotated key cannot authorize anything —
  // rotation is the documented kill switch for outstanding markers.
  if (marker.key_id !== key.key_id) {
    throw new KernelError({
      code: "CROSS_OWNER_MARKER_INVALID",
      message: `marker key_id '${marker.key_id}' does not match the active key '${key.key_id}' (rotated?)`,
      detail: { marker_key_id: marker.key_id, active_key_id: key.key_id },
    });
  }
  const expected = computeMarkerHmac(
    key.key,
    marker.issued_at,
    marker.expires_at,
    marker.reason,
  );
  if (!hmacEqual(expected, marker.hmac)) {
    throw new KernelError({
      code: "CROSS_OWNER_MARKER_INVALID",
      message: "cross-owner bypass marker has an invalid signature",
    });
  }
  // The reason binds the marker to ONE task — a marker minted for a
  // different driver_state_id cannot be replayed against this recovery.
  if (!reasonEncodesDriver(marker.reason, target.driver_state_id)) {
    throw new KernelError({
      code: "CROSS_OWNER_MARKER_INVALID",
      message: `marker reason does not encode the target driver_state_id '${target.driver_state_id}'`,
      detail: { reason: marker.reason, driver_state_id: target.driver_state_id },
    });
  }
  if (marker.expires_at < tx.now) {
    throw new KernelError({
      code: "BYPASS_MARKER_EXPIRED",
      message: `cross-owner bypass marker expired at ${marker.expires_at} (tx.now=${tx.now})`,
      detail: { expires_at: marker.expires_at, tx_now: tx.now },
    });
  }
  // Single-use: the live row must still exist AND match the presented
  // marker. A valid signature with no live row means the marker was
  // already consumed; a live row with a different signature means a
  // newer marker superseded the one presented.
  const row = await tx.queryRow<{ hmac: string }>(
    "SELECT hmac FROM bypass_markers WHERE id = 1",
  );
  if (row === null) {
    throw new KernelError({
      code: "CROSS_OWNER_MARKER_CONSUMED",
      message: "cross-owner bypass marker has already been consumed",
    });
  }
  if (!hmacEqual(String(row.hmac), marker.hmac)) {
    throw new KernelError({
      code: "CROSS_OWNER_MARKER_INVALID",
      message: "presented marker does not match the live bypass_markers row",
    });
  }
  await tx.exec("DELETE FROM bypass_markers WHERE id = 1");
}

// Verify a direct-write bypass marker's signature against the active
// key. Expiry is already checked by `bypassMarkerGuard` before this
// runs; this is the forge-resistance gate. Unlike the cross-owner
// validator it does not consume the row — single-use is the cross-owner
// recovery ritual, and no MVP surface performs a marker-authorized
// direct state.db write yet.
function verifyBypassHmac(_tx: Transaction, marker: BypassMarker): void {
  const key = loadBypassKey();
  if (key === null) {
    throw new KernelError({
      code: "BYPASS_KEY_MISSING",
      message:
        "bypass marker verification needs a bypass-HMAC key — set PIPELINE_BYPASS_HMAC_KEY or install a user-global ~/.loom/bypass-hmac.key",
    });
  }
  if (marker.key_id !== key.key_id) {
    throw new KernelError({
      code: "BYPASS_MARKER_INVALID",
      message: `marker key_id '${marker.key_id}' does not match the active key '${key.key_id}' (rotated?)`,
      detail: { marker_key_id: marker.key_id, active_key_id: key.key_id },
    });
  }
  const expected = computeMarkerHmac(
    key.key,
    marker.issued_at,
    marker.expires_at,
    marker.reason,
  );
  if (!hmacEqual(expected, marker.hmac)) {
    throw new KernelError({
      code: "BYPASS_MARKER_INVALID",
      message: "bypass marker has an invalid signature",
    });
  }
}

// Constant-time hex-digest comparison. Equal length is required by
// `timingSafeEqual`; a length mismatch is an immediate non-match (and
// itself reveals nothing beyond "wrong length").
function hmacEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ============================================================================
// Guard contracts
// ============================================================================

export interface SpawnGuardConfig {
  duplicate_window_ms?: number;
  // When the call comes from a fanout, sibling launches of the same
  // agent name are explicitly not duplicates of each other — the
  // triple `(agent, phase, agent_run_id)` differentiates them. The
  // caller signals "fanout context" via the field; absent it the
  // guard uses the `(agent, phase)` pair.
  fanout_agent_run_id?: string;
}

export interface OwnerCheckTarget {
  driver_state_id: string;
  caller_owner_id: string | null;
}

// The full marker a caller presents — every field except `key_id`
// feeds the HMAC-SHA256 over (issued_at || expires_at || reason);
// `key_id` names the signing key so a rotation mismatch is legible.
export interface BypassMarker {
  issued_at: NowToken;
  expires_at: NowToken;
  reason: string;
  hmac: string;
  key_id: string;
}

export interface BypassMarkerContext {
  marker?: BypassMarker;
}

// ============================================================================
// SpawnGuard
// ============================================================================

// Refuses to create a duplicate `pending_agents` row for the same
// `(agent, phase)` pair within the duplicate-window. Window cutoff
// is computed from `tx.now` — replay re-supplies the same NowToken
// from the idempotency ledger, so the cutoff is bit-identical across
// the original commit and any retry.
export async function spawnGuard(
  tx: Transaction,
  agent: string,
  phase: string,
  config?: SpawnGuardConfig,
): Promise<void> {
  const window =
    config?.duplicate_window_ms ?? DEFAULT_SPAWN_DUPLICATE_WINDOW_MS;
  const cutoff = offsetNowToken(tx.now, -window);

  // Fanout-aware variant: a `FanoutStage` launches N siblings of the
  // same agent name concurrently, each with its own agent_run_id —
  // that triple is the spec's documented disambiguator, so sibling
  // launches MUST NOT trip each other. The kernel trusts the fresh
  // agent_run_id (a UUID) to differentiate them; an actual collision
  // would surface as a PK conflict on the pending_agents insert that
  // follows the guard. The duplicate-window check is therefore
  // suppressed in fanout mode.
  if (config?.fanout_agent_run_id !== undefined) return;

  const existing = await tx.queryRow<{ agent_run_id: string }>(
    "SELECT agent_run_id FROM pending_agents " +
      "WHERE agent = ? AND phase = ? AND started_at > ?",
    [agent, phase, cutoff],
  );
  if (existing === null) return;
  throw new KernelError({
    code: "DUPLICATE_SPAWN",
    message: `agent='${agent}' in phase='${phase}' has an active spawn (${existing.agent_run_id}) started within ${window / 1000}s`,
    detail: {
      existing_agent_run_id: existing.agent_run_id,
      window_ms: window,
      agent,
      phase,
    },
  });
}

// ============================================================================
// PhaseTransitionGuard
// ============================================================================

const TERMINAL_PHASE_STATUSES = new Set(["completed", "skipped"]);
const VALID_PHASE_STATUSES = new Set([
  "pending",
  "in_progress",
  "completed",
  "skipped",
]);

// Refuses a transition from a terminal phase status back to a
// non-terminal one. Same effect as INV_010 but at the write
// boundary — the row never lands in the DB at all, so the
// invariant on the next commit has nothing to flag.
export function phaseTransitionGuard(
  _tx: Transaction,
  phase: string,
  fromStatus: string,
  toStatus: string,
): void {
  if (!VALID_PHASE_STATUSES.has(toStatus)) {
    throw new KernelError({
      code: "PHASE_TRANSITION_INVALID",
      message: `phase '${phase}' target status '${toStatus}' is not a known PhaseStatus`,
      detail: { phase, from: fromStatus, to: toStatus },
    });
  }
  if (!TERMINAL_PHASE_STATUSES.has(fromStatus)) return;
  if (TERMINAL_PHASE_STATUSES.has(toStatus)) return;
  throw new KernelError({
    code: "PHASE_TRANSITION_INVALID",
    message: `phase '${phase}' cannot move from terminal '${fromStatus}' to '${toStatus}'`,
    detail: { phase, from: fromStatus, to: toStatus },
  });
}

// ============================================================================
// OwnerCheckGuard
// ============================================================================

// Refuses a cross-owner operation unless a valid HMAC-signed
// `cross_owner_bypass` marker is presented. Same-owner ops and
// pre-claim ops (owner_id IS NULL on disk) pass without ceremony. A
// naked boolean flag is intentionally NOT enough — the marker is
// HMAC-keyed, single-use, TTL-bounded, and bound to the target
// driver_state_id. The HMAC validation itself is forward-declared
// (`verifyOwnerBypassMarker`); the guard's job is the
// REQUIRED/PRESENT branch.
export async function ownerCheckGuard(
  tx: Transaction,
  target: OwnerCheckTarget,
  marker?: BypassMarker,
): Promise<void> {
  const row = await tx.queryRow<{ owner_id: string | null }>(
    "SELECT owner_id FROM pipeline_state WHERE id = 1",
  );
  if (row === null) return; // pre-init; no ownership concept yet.
  if (row.owner_id === null) return; // unclaimed; first writer claims.
  if (row.owner_id === target.caller_owner_id) return; // same owner.

  // Cross-owner. A marker is mandatory; HMAC verification follows.
  if (marker === undefined) {
    throw new KernelError({
      code: "CROSS_OWNER_REQUIRED",
      message: `cross-owner operation on driver_state_id='${target.driver_state_id}' requires a signed cross_owner_bypass marker`,
      detail: {
        owner_id: row.owner_id,
        caller_owner_id: target.caller_owner_id,
      },
    });
  }
  // Cross-owner with a marker: verify its signature against the active
  // key and consume it in THIS tx. A bad signature / wrong target /
  // rotated key surfaces CROSS_OWNER_MARKER_INVALID; a replay after
  // consume surfaces CROSS_OWNER_MARKER_CONSUMED; an expired marker
  // surfaces BYPASS_MARKER_EXPIRED; no key surfaces BYPASS_KEY_MISSING.
  await verifyOwnerBypassMarker(tx, target, marker);
}

// ============================================================================
// BypassMarkerGuard
// ============================================================================

// Refuses a direct state.db write unless a valid HMAC-TTL bypass
// marker is attached. The expiry comparison reads `tx.now` against
// `marker.expires_at` — same deterministic comparison the spawn-
// duplicate window uses. HMAC verification is forward-declared.
export function bypassMarkerGuard(
  tx: Transaction,
  context: BypassMarkerContext,
): void {
  const marker = context.marker;
  if (marker === undefined) {
    throw new KernelError({
      code: "BYPASS_MARKER_REQUIRED",
      message: "direct state.db write refused without a bypass marker",
    });
  }
  if (marker.expires_at < tx.now) {
    throw new KernelError({
      code: "BYPASS_MARKER_EXPIRED",
      message: `bypass marker expired at ${marker.expires_at} (tx.now=${tx.now})`,
      detail: {
        expires_at: marker.expires_at,
        tx_now: tx.now,
      },
    });
  }
  verifyBypassHmac(tx, marker);
}
