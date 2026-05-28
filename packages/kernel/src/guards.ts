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
// the same verdict as the original commit. The single exception is
// `subtractMs` below: the `Date` constructor there parses the
// supplied `NowToken` STRING only — it never reads the host clock.
// The `// allow-ambient-clock` marker on the call line is the
// load-bearing exception flag the lint pass recognizes.

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

// Subtract `ms` from a NowToken. The `Date` constructor here operates
// on the input ISO-8601 string only — `Date.parse` of a stable input
// is deterministic across hosts. This is the documented exception to
// the ambient-clock ban; lint matches the marker comment on the same
// line.
function subtractMs(now: NowToken, ms: number): NowToken {
  const epoch = Date.parse(now);
  return new Date(epoch - ms).toISOString() as NowToken; // allow-ambient-clock: parses the supplied NowToken string only; never reads the host clock
}

// Forward-declared HMAC-verification stubs. Both throw
// NOT_IMPLEMENTED until the cross-owner recovery + bypass-marker
// table land. Guards delegate so the call-site signature is stable
// across the forward gap; tests exercise the pre-delegation paths
// (REQUIRED / EXPIRED) without reaching these.
function verifyOwnerBypassMarker(
  _tx: Transaction,
  _target: OwnerCheckTarget,
): void {
  throw new KernelError({
    code: "NOT_IMPLEMENTED",
    message: "cross-owner bypass-marker verification is not yet implemented",
  });
}

function verifyBypassHmac(
  _tx: Transaction,
  _marker: BypassMarker,
): void {
  throw new KernelError({
    code: "NOT_IMPLEMENTED",
    message: "bypass-marker HMAC verification is not yet implemented",
  });
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

export interface BypassMarker {
  hmac: string;
  expires_at: NowToken;
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
  const cutoff = subtractMs(tx.now, window);

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
  // The HMAC validator throws NOT_IMPLEMENTED for now; once it
  // lands, the same call path surfaces
  // CROSS_OWNER_MARKER_INVALID / CROSS_OWNER_MARKER_CONSUMED.
  verifyOwnerBypassMarker(tx, target);
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
