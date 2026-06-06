// Kernel-generic invariants + the `runInvariants(tx)` dispatcher.
//
// Two design points keep the body honest:
//
//   1. Every comparison against "now" reads `state.now` — itself
//      `tx.now` threaded through `narrowStateForBundle`. A wall-clock
//      read inside an invariant body would flip the verdict between
//      original commit and replay, silently breaking the idempotency
//      ledger's "same input → same output" contract.
//
//   2. Each invariant declares the `BundleStateView` field paths it
//      reads. The dispatcher uses the UNION of declared paths to
//      decide which `KernelSnapshots` fields to materialize (so an
//      invariant set that never touches the ledger never pays the
//      SELECT cost). A future skip-on-unchanged optimizer can use the
//      same declarations to drop invariants whose paths did not move
//      on a given commit; activation point is flagged on
//      `runInvariants` below.

import { offsetNowToken } from "./lib/now-arith.js";
import { loadState } from "./state/load.js";
import type {
  FindingSnapshotRow,
  Invariant,
  KernelSnapshots,
  Violation,
} from "./types/invariants.js";
import type { AgentRecord } from "./types/agent-result.js";
import type { IdempotencyLedgerEntry, IdempotencyOp } from "./types/idempotency.js";
import type { BundleStateView } from "./types/state.js";
import type { Transaction } from "./types/transaction.js";
import { narrowStateForBundle } from "./narrow.js";
import {
  AGENT_RECORD_COLUMNS,
  LEDGER_COLUMNS,
  mapAgentRecord,
  mapLedgerRow,
  type AgentRecordRow,
  type LedgerRow,
} from "./lib/row-mappers.js";

// ============================================================================
// Constants
// ============================================================================

// Beyond plausible single-spawn wall-time (provider p99 + transport
// flake). A `pending_agents` row older than this with no recorded
// provider-call ledger entry is a zombie spawn — the external host
// never returned, recovery is the path forward, and the invariant
// surfaces the forensics.
export const ZOMBIE_PENDING_MS = 50 * 60 * 1000;

// Idempotency-op tags accepted in ledger keys. Mirror of the union in
// `types/idempotency.ts`; duplicated here so the regex can be built
// once at module load.
const IDEMPOTENCY_OPS: readonly IdempotencyOp[] = [
  "agent-result",
  "user-answer",
  "task-create",
  "provider-call",
  "provider-stream-resume",
  "side-effect-hook",
  "recovery",
  "metric-finalize",
  "mcp-tool-call",
];

// `${op}:<anything-non-empty>` — the suffix is opaque to the kernel
// (caller-supplied identifier), so the only shape rule is "starts
// with a known op tag, followed by a single colon, followed by at
// least one character".
const LEDGER_KEY_PATTERN = new RegExp(
  `^(?:${IDEMPOTENCY_OPS.join("|")}):.+$`,
);

// ISO-8601 UTC shape — `YYYY-MM-DDTHH:MM:SS[.sss]Z`. NowToken values
// are minted from `new Date().toISOString()` and must round-trip
// through the ledger unchanged; the schema-meta invariant catches
// values that diverge from that shape (e.g., a stale fixture writing
// a naive date string).
const ISO_8601_UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

// ============================================================================
// Invariant factory
// ============================================================================

// `Object.assign` attaches the declared `reads` metadata to the
// callable in a way TypeScript can verify against the `Invariant`
// interface. Inlining the assignment per invariant would work but
// duplicates the assertion shape; the helper keeps each invariant
// body to its rule.
function defineInvariant(
  reads: readonly string[],
  fn: (state: BundleStateView, snapshots: KernelSnapshots) => Violation | null,
): Invariant {
  return Object.assign(fn, { reads });
}

// ============================================================================
// Schema-meta invariant (1)
// ============================================================================

// Catches stored values that escape the JSON-CHECK / column-CHECK
// constraints — typically a fixture or external write that bypassed
// the kernel's wrappers. The SQL layer already refuses malformed JSON
// and out-of-set enums; this invariant double-checks the
// timestamp / non-empty / enum-membership shape on the JS side so a
// future loosening of the SQL constraints does not silently widen the
// accepted set.
export const invSchemaState: Invariant = defineInvariant(["*"], (state) => {
  if (state.bundle.length === 0) {
    return {
      code: "INV_SCHEMA_STATE",
      message: "pipeline_state.bundle must be non-empty",
    };
  }
  if (state.task.length === 0) {
    return {
      code: "INV_SCHEMA_STATE",
      message: "pipeline_state.task must be non-empty",
    };
  }
  if (state.driver_state_id.length === 0) {
    return {
      code: "INV_SCHEMA_STATE",
      message: "pipeline_state.driver_state_id must be non-empty",
    };
  }
  if (!ISO_8601_UTC_PATTERN.test(state.started_at)) {
    return {
      code: "INV_SCHEMA_STATE",
      message: `pipeline_state.started_at not ISO-8601 UTC: ${state.started_at}`,
      detail: { started_at: state.started_at },
    };
  }
  if (state.ended_at !== null && !ISO_8601_UTC_PATTERN.test(state.ended_at)) {
    return {
      code: "INV_SCHEMA_STATE",
      message: `pipeline_state.ended_at not ISO-8601 UTC: ${state.ended_at}`,
      detail: { ended_at: state.ended_at },
    };
  }
  return null;
});

// ============================================================================
// State-shape invariants (9)
// ============================================================================

// complexity ∈ {medium, complex} + any phase completed → agents_count > 0.
// "complexity" is a generic decisions key bundles may or may not
// populate. Absent decisions.complexity → skip.
export const inv001: Invariant = defineInvariant(
  ["phases", "agents_count", "decisions.complexity"],
  (state) => {
    const complexity = state.decisions["complexity"];
    if (complexity !== "medium" && complexity !== "complex") return null;
    const anyCompleted = state.phases.some((p) => p.status === "completed");
    if (!anyCompleted) return null;
    if (state.agents_count > 0) return null;
    return {
      code: "INV_001",
      message: `complexity=${complexity} with a completed phase requires agents_count > 0 (got 0)`,
      detail: {
        complexity,
        completed_phases: state.phases
          .filter((p) => p.status === "completed")
          .map((p) => p.name),
      },
    };
  },
);

// Any completed phase → agent_records rows exist for that phase
// (unless phase_extension.allow_empty marks the phase as legitimately
// agent-free). Reads from the agent_records snapshot; missing
// snapshot means the dispatcher decided this invariant set never
// declared the path — which would be a wiring bug.
export const inv002: Invariant = defineInvariant(
  ["phases", "agent_records"],
  (state, snapshots) => {
    const records = snapshots.agent_records ?? [];
    for (const phase of state.phases) {
      if (phase.status !== "completed") continue;
      if (phase.phase_extension?.["allow_empty"] === true) continue;
      const hit = records.some((r) => r.phase === phase.name);
      if (!hit) {
        return {
          code: "INV_002",
          message: `phase '${phase.name}' is completed but has no agent_records rows`,
          detail: { phase: phase.name },
        };
      }
    }
    return null;
  },
);

// A skipped phase must carry the reason. Catches force-skip paths
// that forgot to populate the audit-friendly field.
export const inv003: Invariant = defineInvariant(["phases"], (state) => {
  for (const phase of state.phases) {
    if (phase.status !== "skipped") continue;
    if (phase.skipped_reason !== null && phase.skipped_reason.length > 0) {
      continue;
    }
    return {
      code: "INV_003",
      message: `phase '${phase.name}' is skipped but skipped_reason is empty`,
      detail: { phase: phase.name },
    };
  }
  return null;
});

// Verdict counter cannot exceed the running agents_count tally.
export const inv004: Invariant = defineInvariant(
  ["agent_verdicts", "agents_count"],
  (state) => {
    if (state.agent_verdicts.length <= state.agents_count) return null;
    return {
      code: "INV_004",
      message: `agent_verdicts (${state.agent_verdicts.length}) exceeds agents_count (${state.agents_count})`,
      detail: {
        verdict_count: state.agent_verdicts.length,
        agents_count: state.agents_count,
      },
    };
  },
);

// A non-null terminal verdict on the pipeline → every phase is
// completed or skipped. The phase set is bundle-declared (kernel reads
// `state.phases`), so the rule is open over phase names.
export const inv007: Invariant = defineInvariant(
  ["verdict", "phases"],
  (state) => {
    if (state.verdict === null) return null;
    const unsettled = state.phases.filter(
      (p) => p.status !== "completed" && p.status !== "skipped",
    );
    if (unsettled.length === 0) return null;
    return {
      code: "INV_007",
      message: `verdict='${state.verdict}' but ${unsettled.length} phase(s) not terminal`,
      detail: {
        verdict: state.verdict,
        unsettled: unsettled.map((p) => ({ name: p.name, status: p.status })),
      },
    };
  },
);

// Acceptance veto: a terminal `accepted` verdict cannot coexist with a
// LIVE blocking finding. "Live" = severity blocking, status open, and not
// retired by a walk-back (`superseded_by_iteration IS NULL`). A finding
// the human accepted / dismissed / marked fixed is not open; one a replan
// retired is superseded — so the only thing this catches is a genuinely
// unaddressed blocker the record would otherwise paper over by reading
// `accepted`. The rule is generic over the lifecycle columns: it names no
// phase and no domain category, so superseded planning findings fall out
// for free (they are not live) and the check reduces to the last surviving
// round of whatever phase still carries an open blocker. Dormant on every
// non-terminal tick (verdict null) — it only has an opinion at finalize.
export const inv008: Invariant = defineInvariant(
  ["verdict", "findings"],
  (state, snapshots) => {
    if (state.verdict !== "accepted") return null;
    const findings = snapshots.findings ?? [];
    for (const f of findings) {
      if (f.severity !== "blocking") continue;
      if (f.status !== "open") continue;
      if (f.superseded_by_iteration !== null) continue;
      return {
        code: "INV_008",
        message:
          "verdict='accepted' cannot coexist with a live blocking finding " +
          `(phase '${f.phase}', iteration ${f.iteration}, status open, not superseded)`,
        detail: {
          phase: f.phase,
          iteration: f.iteration,
          status: f.status,
        },
      };
    }
    return null;
  },
);

// Phase status stays within the known PhaseStatus union. The SQL
// CHECK constraint enforces this on writes; the invariant adds a
// JS-side double-check that catches drift if a future migration
// relaxes the constraint.
const KNOWN_PHASE_STATUSES = new Set([
  "pending",
  "in_progress",
  "completed",
  "skipped",
]);
export const inv010: Invariant = defineInvariant(["phases"], (state) => {
  for (const phase of state.phases) {
    if (KNOWN_PHASE_STATUSES.has(phase.status)) continue;
    return {
      code: "INV_010",
      message: `phase '${phase.name}' has unknown status '${phase.status}'`,
      detail: { phase: phase.name, status: phase.status },
    };
  }
  return null;
});

// Phase-prereq ordering: a phase that has left `pending` (i.e., is
// in_progress, completed, or skipped) must have every declared
// prereq settled (completed or skipped). Prereqs come from
// `phase_extension.prereqs` — a bundle-declared optional list.
export const inv011: Invariant = defineInvariant(["phases"], (state) => {
  const byName = new Map(state.phases.map((p) => [p.name, p]));
  for (const phase of state.phases) {
    if (phase.status === "pending") continue;
    const prereqsRaw = phase.phase_extension?.["prereqs"];
    if (!Array.isArray(prereqsRaw)) continue;
    for (const dep of prereqsRaw) {
      if (typeof dep !== "string") continue;
      const depPhase = byName.get(dep);
      if (depPhase === undefined) continue;
      if (depPhase.status === "completed" || depPhase.status === "skipped") {
        continue;
      }
      return {
        code: "INV_011",
        message: `phase '${phase.name}' left pending while prereq '${dep}' is '${depPhase.status}'`,
        detail: {
          phase: phase.name,
          prereq: dep,
          prereq_status: depPhase.status,
        },
      };
    }
  }
  return null;
});

// A terminal phase status (completed / skipped) cannot coexist with
// an outstanding pending_agents row for that phase — the spawn must
// drain (via deliverAgentResult or cancel-pending recovery) before
// the phase can settle.
export const inv012: Invariant = defineInvariant(
  ["phases", "pending_agents"],
  (state) => {
    for (const phase of state.phases) {
      if (phase.status !== "completed" && phase.status !== "skipped") continue;
      const stuck = state.pending_agents.filter((p) => p.phase === phase.name);
      if (stuck.length === 0) continue;
      return {
        code: "INV_012",
        message: `phase '${phase.name}' status='${phase.status}' but ${stuck.length} pending_agents row(s) still present`,
        detail: {
          phase: phase.name,
          status: phase.status,
          pending_agent_run_ids: stuck.map((p) => p.agent_run_id),
        },
      };
    }
    return null;
  },
);

// ============================================================================
// Ledger-consistency invariants (3)
// ============================================================================

// Every ledger row's `key` matches `<known-op>:<suffix>`. Catches
// loader / test fixtures writing malformed keys and any future
// IdempotencyOp value that lands on disk before the union is
// extended.
export const inv013: Invariant = defineInvariant(
  ["kernel_idempotency_ledger"],
  (_state, snapshots) => {
    const ledger = snapshots.ledger ?? [];
    for (const row of ledger) {
      if (LEDGER_KEY_PATTERN.test(row.key)) continue;
      return {
        code: "INV_013",
        message: `kernel_idempotency_ledger.key '${row.key}' does not match the IdempotencyOp:suffix pattern`,
        detail: { key: row.key },
      };
    }
    return null;
  },
);

// An `agent-result:<arid>` ledger row with a non-null response_blob
// means the kernel committed the delivery — there cannot be a
// pending_agents row carrying the same agent_run_id, or the in-tx
// pending drain was skipped. A violation indicates a kernel-side
// regression (the delivery tx and pending drain co-commit by
// construction).
export const inv014: Invariant = defineInvariant(
  ["kernel_idempotency_ledger", "pending_agents"],
  (state, snapshots) => {
    const ledger = snapshots.ledger ?? [];
    const pendingByArid = new Map(
      state.pending_agents.map((p) => [p.agent_run_id, p]),
    );
    for (const row of ledger) {
      if (!row.key.startsWith("agent-result:")) continue;
      if (row.response_blob === null) continue;
      const arid = row.key.slice("agent-result:".length);
      const pending = pendingByArid.get(arid);
      if (pending === undefined) continue;
      return {
        code: "INV_014",
        message: `agent-result ledger entry committed for agent_run_id='${arid}' but pending_agents row still present`,
        detail: { agent_run_id: arid, ledger_key: row.key },
      };
    }
    return null;
  },
);

// Zombie pending detection — a pending_agents row older than the
// zombie threshold with no `provider-call:<arid>` ledger entry means
// the external host never returned. Comparison uses `state.now`
// against `pending_agents.started_at`; both values are NowTokens
// (ISO-8601 strings) and string comparison is order-equivalent to
// numeric date comparison on that shape.
export const inv015: Invariant = defineInvariant(
  ["pending_agents", "kernel_idempotency_ledger"],
  (state, snapshots) => {
    const ledger = snapshots.ledger ?? [];
    const providerCallArids = new Set<string>();
    for (const row of ledger) {
      if (row.key.startsWith("provider-call:")) {
        providerCallArids.add(row.key.slice("provider-call:".length));
      }
    }
    const cutoff = offsetNowToken(state.now, -ZOMBIE_PENDING_MS);
    for (const pending of state.pending_agents) {
      if (pending.started_at >= cutoff) continue;
      if (providerCallArids.has(pending.agent_run_id)) continue;
      return {
        code: "INV_015",
        message: `pending_agents row '${pending.agent_run_id}' older than zombie threshold with no provider-call ledger entry`,
        detail: {
          agent_run_id: pending.agent_run_id,
          started_at: pending.started_at,
          state_now: state.now,
          threshold_ms: ZOMBIE_PENDING_MS,
        },
      };
    }
    return null;
  },
);

// ============================================================================
// Registry
// ============================================================================

export const kernelInvariants: readonly Invariant[] = [
  invSchemaState,
  inv001,
  inv002,
  inv003,
  inv004,
  inv007,
  inv008,
  inv010,
  inv011,
  inv012,
  inv013,
  inv014,
  inv015,
];

// Bundle-registered invariants — a TEST-ONLY seam. Production threads the
// active registry's invariants PER CALL (see `runInvariants` below): the
// fleet server is one process over N projects with possibly different
// bundles, so a module-global would cross-contaminate one project's tx with
// another bundle's invariants and raise FALSE violations (e.g. the code
// floor demanding `lint_result` on a spec-bundle project). This list has
// ZERO production callers; it exists so the invariant-runner's commit-time
// behaviour can be exercised in isolation. Reset between cases via
// `_resetInvariantsForTest`.
const additionalInvariants: Invariant[] = [];

export function registerInvariant(inv: Invariant): void {
  additionalInvariants.push(inv);
}

// Test-only hook. Underscore-prefixed to flag the off-limits status
// to production callers; tests need it to keep the module-local
// `additionalInvariants` list from bleeding state across cases.
export function _resetInvariantsForTest(): void {
  additionalInvariants.length = 0;
}

// ============================================================================
// Snapshot materializer
// ============================================================================

// Walk the union of declared `reads` paths and decide which
// kernel-internal collections to materialize. Each snapshot is built
// in a single SELECT inside the caller's tx so the read sees the
// in-flight write set (the very state the invariants are about to
// validate).
export async function buildKernelSnapshots(
  tx: Transaction,
  invariants: readonly Invariant[],
): Promise<KernelSnapshots> {
  let needsAgentRecords = false;
  let needsLedger = false;
  let needsFindings = false;
  for (const inv of invariants) {
    for (const path of inv.reads) {
      if (path === "*" || path.startsWith("agent_records")) {
        needsAgentRecords = true;
      }
      if (path === "*" || path.startsWith("kernel_idempotency_ledger")) {
        needsLedger = true;
      }
      if (path === "*" || path.startsWith("findings")) {
        needsFindings = true;
      }
    }
  }

  const snapshots: KernelSnapshots = {};
  if (needsAgentRecords) {
    snapshots.agent_records = await loadAgentRecords(tx);
  }
  if (needsLedger) {
    snapshots.ledger = await loadLedger(tx);
  }
  if (needsFindings) {
    snapshots.findings = await loadFindings(tx);
  }
  return snapshots;
}

// Generic findings projection for invariant bodies — only the lifecycle
// columns, no domain fields. Built in one SELECT inside the caller's tx so
// the read sees the in-flight write set (the very state being validated).
async function loadFindings(tx: Transaction): Promise<FindingSnapshotRow[]> {
  const rows = await tx.queryAll<{
    phase: unknown;
    iteration: unknown;
    severity: unknown;
    status: unknown;
    superseded_by_iteration: unknown;
  }>(
    "SELECT phase, iteration, severity, status, superseded_by_iteration " +
      "FROM findings ORDER BY id ASC",
  );
  return rows.map((r) => ({
    phase: String(r.phase),
    iteration: Number(r.iteration),
    severity: String(r.severity),
    status: String(r.status),
    superseded_by_iteration:
      r.superseded_by_iteration === null ? null : Number(r.superseded_by_iteration),
  }));
}

async function loadAgentRecords(tx: Transaction): Promise<AgentRecord[]> {
  const rows = await tx.queryAll<AgentRecordRow>(
    `SELECT ${AGENT_RECORD_COLUMNS} FROM agent_records ORDER BY id ASC`,
  );
  return rows.map(mapAgentRecord);
}

async function loadLedger(tx: Transaction): Promise<IdempotencyLedgerEntry[]> {
  const rows = await tx.queryAll<LedgerRow>(
    `SELECT ${LEDGER_COLUMNS} FROM kernel_idempotency_ledger ORDER BY first_seen_ts ASC`,
  );
  return rows.map(mapLedgerRow);
}

// ============================================================================
// runInvariants — single entry point for pre-commit validation
// ============================================================================

// Dispatch order:
//   1. Load PipelineState via the same materializer the kernel uses
//      for any other read of the in-flight tx.
//   2. Narrow to BundleStateView so invariants cannot reach into
//      FSM-internal fields (driver.*, schema_version).
//   3. Take the union of `reads` declarations across kernel + the
//      per-call bundle invariants (+ the test seam) and materialize
//      only the snapshots the union demands.
//   4. Run every invariant (no skip-on-unchanged this revision; the
//      `reads` metadata is shipped forward-compatible for the
//      typed-mutator tracker to activate later).
//
// `bundleInvariants` is threaded PER CALL by the FSM tick (where the active
// registry is in scope) so a gate auto-approve / finalize / step commit is
// vetoed by the running bundle's own rules — the deterministic safety floor
// included. It is per-call rather than a module-global precisely because the
// fleet server runs many projects (possibly different bundles) in one
// process; see the `additionalInvariants` note above. The default keeps the
// single-arg call (kernel-only) valid for the utility transactions that hold
// no registry (backup / restore / marker / hook-ledger writes).
export async function runInvariants(
  tx: Transaction,
  bundleInvariants: readonly Invariant[] = [],
): Promise<Violation[]> {
  const fullState = await loadState(tx);
  const state = narrowStateForBundle(fullState, tx.now);
  const all: readonly Invariant[] = [
    ...kernelInvariants,
    ...additionalInvariants,
    ...bundleInvariants,
  ];
  const snapshots = await buildKernelSnapshots(tx, all);
  const violations: Violation[] = [];
  for (const inv of all) {
    const result = inv(state, snapshots);
    if (result !== null) violations.push(result);
  }
  return violations;
}
