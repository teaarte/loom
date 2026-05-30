// Code-bundle domain invariants + the deterministic safety floor.
//
// These run inside the same `runInvariants(tx)` call as the substrate's
// own state-shape rules; the substrate does not care whether a violation
// came from a generic rule or one of these. A non-null return rolls the
// commit back. Each invariant is a pure function over the narrow state
// projection plus declared `reads` metadata — no clock, no IO; replay
// re-runs them against the stored state and must reach the same verdict.
//
// Numbering: the substrate owns the low range; bundle rules start at 101.
// The four `INV_CODE_*` rules encode the code domain (a plan gate implies
// planning is closed, sacred tests can't be silently rewritten, an
// acceptance PASS can't coexist with open blocking findings). The three
// floor rules (`INV_lint_clean` / `INV_tests_pass` / `INV_typecheck_clean`)
// are the deterministic boundary that makes a fully-autonomous final gate
// defensible — they READ a status field; the deterministic Step that
// WRITES it (a shell-out to lint / test / typecheck) is the writer the
// floor depends on. The floor only engages when the final role's policy
// is literally `auto`; under the honest baseline (`on-blockers`) the
// human-or-blocker gate is the boundary and the floor stays dormant.

import type {
  BundleStateView,
  Invariant,
  KernelSnapshots,
  Violation,
} from "@loom/kernel";

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

// A gate counts as "approved" whether a human approved it or a policy
// auto-approved it — both close the checkpoint.
function isApproved(status: string | undefined): boolean {
  return status === "approved" || status === "auto-approved";
}

function phaseStatus(state: BundleStateView, name: string): string | null {
  const row = state.phases.find((p) => p.name === name);
  return row ? row.status : null;
}

// Narrow a `bundle_state` sub-object's `status` field to `"ok"`. The
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
// Domain rules — INV_CODE_101..104
// ============================================================================

// Once the plan gate is approved, the planning phase must be closed.
export const invCode101: Invariant = defineInvariant(["gates", "phases"], (state) => {
  if (!isApproved(state.gates["gate-plan"]?.status)) return null;
  const planning = phaseStatus(state, "planning");
  if (planning === null) return null; // no planning row yet — nothing to assert
  if (planning === "completed" || planning === "skipped") return null;
  return {
    code: "INV_CODE_101",
    message: `gate-plan approved but planning phase is '${planning}'`,
    detail: { planning_status: planning },
  };
});

// Once the final gate is approved, both the implementation and validation
// phases must be completed.
export const invCode102: Invariant = defineInvariant(["gates", "phases"], (state) => {
  if (!isApproved(state.gates["gate-final"]?.status)) return null;
  const impl = phaseStatus(state, "implementation");
  const validation = phaseStatus(state, "validation");
  if (impl === "completed" && validation === "completed") return null;
  return {
    code: "INV_CODE_102",
    message: `gate-final approved but implementation='${impl ?? "missing"}' validation='${validation ?? "missing"}'`,
    detail: { implementation_status: impl, validation_status: validation },
  };
});

// Sacred tests: if the implementer modified test files, the final gate may
// only close with explicit HUMAN approval — a policy must not silently
// auto-approve work that rewrote the tests it is judged against.
export const invCode103: Invariant = defineInvariant(
  ["bundle_state.test_files_modified_by_implementer", "gates"],
  (state) => {
    const modified = bundleStateField(state, "test_files_modified_by_implementer");
    if (!Array.isArray(modified) || modified.length === 0) return null;
    const g = state.gates["gate-final"];
    if (!g || !isApproved(g.status)) return null;
    if (g.decided_by === "human") return null;
    return {
      code: "INV_CODE_103",
      message: `implementer modified ${modified.length} test file(s); final gate must be human-approved, not '${g.decided_by}'`,
      detail: { decided_by: g.decided_by, modified_count: modified.length },
    };
  },
);

// An acceptance PASS cannot coexist with open blocking findings from
// implementation-phase reviewers at the latest review iteration.
export const invCode104: Invariant = defineInvariant(["agent_verdicts"], (state) => {
  const acceptance = state.agent_verdicts.find(
    (v) => v.agent === "acceptance" && v.phase === "validation",
  );
  if (!acceptance) return null;
  if (acceptance.verdict !== "PASS" && acceptance.verdict !== "PASS_WITH_WARNINGS") {
    return null;
  }
  const implEntries = state.agent_verdicts.filter(
    (v) => v.phase === "implementation" && v.agent !== "acceptance",
  );
  if (implEntries.length === 0) return null;
  const latestIter = implEntries.reduce((m, v) => Math.max(m, v.iteration ?? 1), 0);
  const offenders = implEntries.filter(
    (v) => v.iteration === latestIter && v.blocking_issues > 0,
  );
  if (offenders.length === 0) return null;
  const sum = offenders.reduce((s, v) => s + v.blocking_issues, 0);
  return {
    code: "INV_CODE_104",
    message: `acceptance.verdict='${acceptance.verdict}' but ${sum} open blocking finding(s) from impl-phase reviewers at iteration=${latestIter}`,
    detail: {
      offenders: offenders.map((v) => ({
        agent: v.agent,
        iteration: v.iteration,
        blocking_issues: v.blocking_issues,
      })),
    },
  };
});

// ============================================================================
// Safety floor — only engages when the final role's policy is `auto`
// ============================================================================

// True only at the moment a fully-autonomous final gate is being approved.
// Under the `on-blockers` baseline the gate's blocker check is the boundary
// and the floor stays dormant, so the substrate never has to write the
// status fields these rules read until a deployment opts into `auto`.
function atFinalAutoApprove(state: BundleStateView): boolean {
  if (state.gate_policies["final"] !== "auto") return false;
  return isApproved(state.gates["gate-final"]?.status);
}

function floorViolation(
  code: string,
  field: string,
  status: string | null,
  value: unknown,
): Violation {
  return {
    code,
    message: `${field} must pass before final auto-approve (status=${status ?? "missing"})`,
    detail: { [field]: value },
  };
}

export const invLintClean: Invariant = defineInvariant(
  ["gate_policies", "gates", "bundle_state.lint_result"],
  (state) => {
    if (!atFinalAutoApprove(state)) return null;
    const lint = bundleStateField(state, "lint_result");
    const status = statusField(lint);
    if (status === "ok") return null;
    return floorViolation("INV_lint_clean", "lint_result", status, lint);
  },
);

export const invTestsPass: Invariant = defineInvariant(
  ["gate_policies", "gates", "bundle_state.test_run"],
  (state) => {
    if (!atFinalAutoApprove(state)) return null;
    const tests = bundleStateField(state, "test_run");
    const status = statusField(tests);
    if (status === "ok") return null;
    return floorViolation("INV_tests_pass", "test_run", status, tests);
  },
);

export const invTypecheckClean: Invariant = defineInvariant(
  ["gate_policies", "gates", "bundle_state.typecheck"],
  (state) => {
    if (!atFinalAutoApprove(state)) return null;
    const tc = bundleStateField(state, "typecheck");
    const status = statusField(tc);
    if (status === "ok") return null;
    return floorViolation("INV_typecheck_clean", "typecheck", status, tc);
  },
);

// Bridge to the loader's auto-policy completeness gate. When a role's
// default (or per-task override) resolves to `auto`, the loader looks for
// an invariant whose FUNCTION NAME is `INV_safety_floor_<role>` — the
// single registered floor for that role. This composite is that anchor for
// the `final` role: it runs the three deterministic checks above and
// surfaces the first failure, so a deployment can flip `final` to `auto`
// and load cleanly, with the floor genuinely enforcing on every
// auto-approve. The function's `name` (not its violation code) is what the
// loader matches.
const safetyFloorFinalImpl = defineInvariant(
  [
    "gate_policies",
    "gates",
    "bundle_state.lint_result",
    "bundle_state.test_run",
    "bundle_state.typecheck",
  ],
  (state, snapshots) =>
    invLintClean(state, snapshots) ??
    invTestsPass(state, snapshots) ??
    invTypecheckClean(state, snapshots),
);
Object.defineProperty(safetyFloorFinalImpl, "name", {
  value: "INV_safety_floor_final",
});
export const invSafetyFloorFinal: Invariant = safetyFloorFinalImpl;

// The full domain + floor set the bundle registers.
export const codeBundleInvariants: Invariant[] = [
  invCode101,
  invCode102,
  invCode103,
  invCode104,
  invLintClean,
  invTestsPass,
  invTypecheckClean,
  invSafetyFloorFinal,
];
