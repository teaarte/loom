// Task-create transaction body — the atomic multi-table insert that
// brings a project's state into existence.
//
// All writes land in the caller's open tx so the canonical pipeline_state
// row, the FSM driver row, the zeroed counters, the seeded phase rows,
// AND the `task-create:<uuid>` idempotency-ledger row co-commit. The
// ledger row is written with `response_blob = null`; the caller updates
// it with the shaped wire envelope once the first FSM tick resolves, so
// a replay with the same client UUID returns the cached creation
// response verbatim.
//
// Replay safety: a second call carrying a `task-create` ledger row that
// already exists reads back the persisted identity and returns it
// WITHOUT inserting a second canonical row — the single-row CHECK on
// pipeline_state would otherwise trip, but reading back is the correct
// behavior on transport-flake retry.
//
// Wall-clock discipline: every timestamp comes from `tx.now`; the task
// id is minted through `ids.ts` (the documented mint-time exception).

import { makeDriverStateId, makeTaskId } from "../ids.js";
import { resolvePreset } from "../policy-presets/index.js";
import { KERNEL_SCHEMA_VERSION, KernelError } from "../state/db.js";
import type { PolicyName } from "../types/policy.js";
import type { GateRole, Phase, StackInfo } from "../types/row-types.js";
import type { Transaction } from "../types/transaction.js";

import { readLedgerRow, writeLedgerRow } from "./ledger.js";

export interface InitializeTaskArgs {
  project_dir: string;
  task: string;
  task_short?: string | null;
  owner_id?: string | null;
  policy_preset?: string;
  // Explicit per-role policy map. When present it wins over
  // `policy_preset`; when both are absent the row stores an empty map.
  // Partial over GateRole — a caller overrides only the roles it cares
  // about; unset roles resolve through the bundle default / kernel baseline.
  gate_policies?: Partial<Record<GateRole, PolicyName>>;
  complexity_hint?: "simple" | "medium" | "complex";
  tests_mode_hint?: "tdd" | "regression-only";
  stack?: StackInfo | null;
  client_idempotency_uuid: string;
  // Phase names declared by the active bundle's flow — the caller reads
  // these off the resolved registry (`registry.bundle.phases`) and the
  // helper seeds one `pending` phase row per entry.
  phases: Phase[];
  // FSM flow name to drive. Defaults to the kernel's `standard` flow.
  flow_name?: string;
}

export interface InitializeTaskResult {
  task_id: string;
  driver_state_id: string;
}

export async function initializeTask(
  tx: Transaction,
  args: InitializeTaskArgs,
): Promise<InitializeTaskResult> {
  const ledgerKey = `task-create:${args.client_idempotency_uuid}`;

  const existing = await readLedgerRow(tx, ledgerKey);
  if (existing !== null) {
    const row = await tx.queryRow<{ task_id: unknown; driver_state_id: unknown }>(
      "SELECT task_id, driver_state_id FROM pipeline_state WHERE id = 1",
    );
    if (row === null) {
      throw new KernelError({
        code: "STATE_NOT_INITIALIZED",
        message: "task-create ledger row present but pipeline_state row missing",
      });
    }
    return {
      task_id: row.task_id === null ? "" : String(row.task_id),
      driver_state_id: String(row.driver_state_id),
    };
  }

  // Occupied-slot pre-check. The aggregate row is single-identity by
  // construction (the `id = 1` CHECK), so a project store holds one task at
  // a time. A surviving row here — past the replay branch above, so under a
  // FRESH client uuid — means a prior task still owns the slot. A blind
  // INSERT would trip the row-identity CHECK and surface a raw backend
  // error to the caller; refuse with a typed, actionable code instead. The
  // transport rotates a FINISHED slot into history before reaching this
  // point, so a row that survives to here is either a live task or a
  // finished one a caller declined to rotate.
  const occupied = await tx.queryRow<{ status: unknown }>(
    "SELECT status FROM pipeline_state WHERE id = 1",
  );
  if (occupied !== null) {
    const status = String(occupied.status);
    const remediation =
      status === "in_progress"
        ? "a task is already running in this project — finish it, recover it, or reset the project"
        : "a finished task still occupies this project — archive it (reset the project) before starting a new one";
    throw new KernelError({
      code: "PROJECT_TASK_ACTIVE",
      message: remediation,
      detail: { status },
    });
  }

  // Bundle resolution (v3 MVP): first enabled bundle, ordered by id.
  // When the registry's config-driven flow selection lands this point
  // re-binds; the refusal stays the same.
  const bundleRow = await tx.queryRow<{ name: unknown }>(
    "SELECT name FROM installed_extensions " +
      "WHERE kind = 'bundle' AND status = 'enabled' ORDER BY id LIMIT 1",
  );
  if (bundleRow === null) {
    throw new KernelError({
      code: "NO_ENABLED_BUNDLE",
      message: "no enabled bundle is installed for this project",
    });
  }
  const bundleName = String(bundleRow.name);

  const gatePolicies = resolveGatePolicies(args);
  const flowName = args.flow_name ?? "standard";
  const taskId = makeTaskId(args.task_short ?? args.task, tx.now);
  const driverStateId = makeDriverStateId();
  const taskShort = args.task_short ?? null;
  const ownerId = args.owner_id ?? null;
  const stackJson = args.stack !== null && args.stack !== undefined
    ? JSON.stringify(args.stack)
    : null;
  const decisionsJson = JSON.stringify(buildInitialDecisions(args));

  await tx.exec(
    "INSERT INTO pipeline_state " +
      "(id, schema_version, project_dir, bundle, task_id, task, task_short, " +
      " driver_state_id, owner_id, status, verdict, started_at, ended_at, " +
      " gate_policies, decisions, bundle_state, files_created, files_modified, " +
      " stack, pipeline_violation, force_used) " +
      "VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 'in_progress', NULL, ?, NULL, " +
      " ?, ?, NULL, '[]', '[]', ?, NULL, 0)",
    [
      KERNEL_SCHEMA_VERSION,
      args.project_dir,
      bundleName,
      taskId,
      args.task,
      taskShort,
      driverStateId,
      ownerId,
      tx.now,
      JSON.stringify(gatePolicies),
      decisionsJson,
      stackJson,
    ],
  );

  await tx.exec(
    "INSERT INTO driver_state (id, flow_name, step_index, complete, pending_user_answer, scratch) " +
      "VALUES (1, ?, 0, 0, NULL, '{}')",
    [flowName],
  );

  await tx.exec(
    "INSERT INTO pipeline_counters " +
      "(id, agents_count, total_tokens_in, total_tokens_out, total_tokens_cached) " +
      "VALUES (1, 0, 0, 0, 0)",
  );

  for (const phase of args.phases) {
    await tx.exec(
      "INSERT INTO phases (name, status, skipped_reason, phase_extension, updated_at) " +
        "VALUES (?, 'pending', NULL, NULL, ?)",
      [phase, tx.now],
    );
  }

  await writeLedgerRow(tx, ledgerKey, {
    driver_state_id: driverStateId,
    task_id: taskId,
    response_blob: null,
  });

  return { task_id: taskId, driver_state_id: driverStateId };
}

function resolveGatePolicies(
  args: InitializeTaskArgs,
): Partial<Record<GateRole, PolicyName>> {
  if (args.gate_policies !== undefined && Object.keys(args.gate_policies).length > 0) {
    return args.gate_policies;
  }
  if (args.policy_preset !== undefined) {
    return resolvePreset(args.policy_preset);
  }
  return {};
}

// Seed `decisions` with the host-supplied hints. `complexity` is the
// generic decisions key kernel invariants (and bundle policies) read;
// `tests_mode` is bundle-consumed. Absent hints leave the key out.
function buildInitialDecisions(
  args: InitializeTaskArgs,
): Record<string, unknown> {
  const decisions: Record<string, unknown> = {};
  if (args.complexity_hint !== undefined) {
    decisions["complexity"] = args.complexity_hint;
  }
  if (args.tests_mode_hint !== undefined) {
    decisions["tests_mode"] = args.tests_mode_hint;
  }
  return decisions;
}
