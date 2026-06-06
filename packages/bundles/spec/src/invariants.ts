// Domain invariants + the deterministic safety floor for this bundle.
//
// These run inside the same invariant pass as the substrate's own
// state-shape rules; the substrate does not care whether a violation came
// from a generic rule or one of these, and a non-null return rolls the
// commit back. Each is a pure function over the narrow state projection
// plus declared `reads` metadata — no clock, no IO — so replay re-runs
// them against the stored state and must reach the same verdict.
//
// Numbering: the substrate owns the low range; bundle rules start at 201
// (a distinct band from the first bundle's 101, so a future multi-bundle
// audit can tell whose rule fired from the code alone).

import type {
  BundleStateView,
  Invariant,
  KernelSnapshots,
  Violation,
} from "@loomfsm/kernel";

// Local typed-identity helper mirroring the substrate's own invariant
// constructor: bind the `reads` metadata onto a pure verdict function.
// The substrate does not export its private constructor, so the bundle
// carries its own one-liner.
function defineInvariant(
  reads: readonly string[],
  fn: (state: BundleStateView, snapshots: KernelSnapshots) => Violation | null,
): Invariant {
  return Object.assign(fn, { reads });
}

function isApproved(status: string | undefined): boolean {
  return status === "approved" || status === "auto-approved";
}

function phaseStatus(state: BundleStateView, name: string): string | null {
  const row = state.phases.find((p) => p.name === name);
  return row ? row.status : null;
}

// Narrow a `bundle_state` sub-object's `status` field to a string. The
// column is an opaque JSON blob on the snapshot, so every read is an
// unknown that must be shape-checked before use.
function statusField(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const s = (value as { status?: unknown }).status;
  return typeof s === "string" ? s : null;
}

function bundleStateField(state: BundleStateView, key: string): unknown {
  return state.bundle_state?.[key];
}

// ============================================================================
// Domain rule — INV_SPEC_201
// ============================================================================

// Once the sign-off gate is approved, the review phase must be closed.
// A generic phase-status assertion that names a NON-code phase — the same
// machinery the first bundle uses over its own phases, proving the
// substrate's phase reasoning carries no code-domain assumption.
//
// Record-time safety (same contract as the first bundle's gate→phase rules):
// the substrate runs invariants at EVERY commit, including the gate-approval
// tick itself, where the gate's own phase (`review-spec`) is legitimately
// still `in_progress` — the FSM settles it on the NEXT tick when the flow
// leaves the phase. So this tolerates the transient non-terminal states and
// fires only on a terminal-but-WRONG status. Within the current PhaseStatus
// union both terminal states (`completed`, `skipped`) are allowed, so this is
// a forward-compat guard; it is kept so the gate→phase contract stays
// documented and rolls back rather than papering over a future terminal
// status outside that set.
export const invSpec201: Invariant = defineInvariant(["gates", "phases"], (state) => {
  if (!isApproved(state.gates["gate-approval"]?.status)) return null;
  const review = phaseStatus(state, "review-spec");
  if (review === null) return null; // no review-spec row yet — nothing to assert
  if (review === "pending" || review === "in_progress") return null; // transient
  if (review === "completed" || review === "skipped") return null; // allowed terminals
  return {
    code: "INV_SPEC_201",
    message: `gate-approval approved but review-spec phase settled to '${review}'`,
    detail: { review_spec_status: review },
  };
});

// ============================================================================
// Safety floor — only engages when the sign-off role's policy is `auto`
// ============================================================================

// True only at the moment a fully-autonomous sign-off is being approved.
// Under any human or on-blockers posture the gate's own check is the
// boundary and the floor stays dormant, so the substrate never has to
// write the status field this rule reads until a deployment opts the
// sign-off role into `auto`.
function atApprovalAutoApprove(state: BundleStateView): boolean {
  if (state.gate_policies["spec-approval"] !== "auto") return false;
  return isApproved(state.gates["gate-approval"]?.status);
}

// Bridge to the loader's auto-policy completeness gate. When the sign-off
// role resolves to `auto`, the loader looks for an invariant whose FUNCTION
// NAME is `INV_safety_floor_spec-approval` and refuses the bundle if it is
// absent. The role name carries a hyphen, which no JS identifier may, so
// the name is stamped via `defineProperty` rather than declared — the
// loader matches the runtime `.name` string, not the source identifier.
//
// The floor reads a generic readiness status a deterministic Step writes
// before the gate; an autonomous sign-off cannot land unless that signal
// is `ok`. The check names nothing about code, build, or tests — only that
// the domain's own readiness writer ran and reported clean.
const safetyFloorApprovalImpl = defineInvariant(
  ["gate_policies", "gates", "bundle_state.spec_readiness"],
  (state) => {
    if (!atApprovalAutoApprove(state)) return null;
    const readiness = bundleStateField(state, "spec_readiness");
    const status = statusField(readiness);
    if (status === "ok") return null;
    return {
      code: "INV_safety_floor_spec-approval",
      message: `spec_readiness must be ok before autonomous sign-off (status=${status ?? "missing"})`,
      detail: { spec_readiness: readiness },
    };
  },
);
Object.defineProperty(safetyFloorApprovalImpl, "name", {
  value: "INV_safety_floor_spec-approval",
});
export const invSafetyFloorApproval: Invariant = safetyFloorApprovalImpl;

// The full domain + floor set the bundle registers.
export const specBundleInvariants: Invariant[] = [
  invSpec201,
  invSafetyFloorApproval,
];
