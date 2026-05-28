// pipeline_run_task — task-create handler.
//
// Composition order:
//   1. assertProjectDirAllowed — refusal lands as an error-shaped wire
//      envelope, NOT a thrown exception.
//   2. Validate client_idempotency_uuid — empty → error envelope.
//   3. Ledger cache lookup — a `task-create:<uuid>` row carrying a
//      materialized response_blob replays the cached creation envelope
//      verbatim (same task_id / driver_state_id, read off the canonical
//      pipeline_state row).
//   4. Parse the raw task string when no policy_preset was supplied.
//   5. Open one withStateTransaction → initializeTask (atomic multi-table
//      insert + co-committed task-create ledger row) + a co-committed
//      audit row → commit.
//   6. Load state, run the FSM to its first directive, shape it.
//   7. Update the ledger row's response_blob with the shaped envelope so
//      a later replay returns it verbatim.
//
// Operational failures (allowlist refusal, missing UUID, kernel-coded
// refusals) become structured error envelopes; the MCP client sees the
// same wire shape for a refusal as for the happy path. Only programmer
// errors throw.

import {
  assertProjectDirAllowed,
  captureNow,
  initializeTask,
  KernelError,
  loadState,
  openDb,
  readLedgerRow,
  runFSM,
  TransactionImpl,
  withStateTransaction,
  writeLedgerRow,
  type GateRole,
  type PolicyName,
  type Registry,
  type Transaction,
} from "@loom/kernel";
import type { TransportResponse } from "@loom/transport-types";

import { parseTaskArgs } from "../lib/parse-task-args.js";
import { createTransportAdapter } from "../transport-adapter.js";
import type { RunTaskInput, RunTaskResponse, ToolHandler } from "../types.js";

export interface RunTaskDeps {
  // Resolve the FSM registry for a project. Production wiring imports the
  // active bundle and assembles the registry; tests inject a ready one.
  // Absent → the handler refuses (the active-task path needs a flow to
  // tick) with a structured error envelope.
  resolveRegistry?: (projectDir: string) => Promise<Registry> | Registry;
  // Allowlist file override threaded to assertProjectDirAllowed. Tests
  // point at a tmpfile; production omits it and gets the default.
  allowlistPath?: string;
}

const UNKNOWN_DRIVER = "d-unknown";

export function createRunTaskTool(
  deps: RunTaskDeps = {},
): ToolHandler<RunTaskInput, RunTaskResponse> {
  const adapter = createTransportAdapter();

  return async (input) => {
    // 1. Project-dir allowlist.
    try {
      await assertProjectDirAllowed(
        input.project_dir,
        deps.allowlistPath !== undefined ? { allowlistPath: deps.allowlistPath } : undefined,
      );
    } catch (err) {
      return refusal(err);
    }

    // 2. client_idempotency_uuid is REQUIRED.
    if (
      typeof input.client_idempotency_uuid !== "string" ||
      input.client_idempotency_uuid.length === 0
    ) {
      return {
        response: errorResponse(
          UNKNOWN_DRIVER,
          "TASK_IDEMPOTENCY_REQUIRED",
          "client_idempotency_uuid is required on every pipeline_run_task call",
        ),
      };
    }

    // 3. Replay — return the cached creation envelope verbatim.
    const cached = await readCachedCreation(input.project_dir, input.client_idempotency_uuid);
    if (cached !== null) return cached;

    if (deps.resolveRegistry === undefined) {
      return {
        response: errorResponse(
          UNKNOWN_DRIVER,
          "REGISTRY_UNAVAILABLE",
          "no registry resolver is wired for the active-task path",
        ),
      };
    }
    const registry = await deps.resolveRegistry(input.project_dir);

    // 4. Parse the raw task only when the host did not name a preset.
    let task = input.task;
    let policyPreset = input.policy_preset;
    let warnings: string[] = [];
    if (policyPreset === undefined) {
      const parsed = parseTaskArgs(input.task);
      task = parsed.task;
      policyPreset = parsed.policy_preset;
      warnings = parsed.warnings;
    }

    // 5. Atomic create + co-committed audit row.
    const identifier =
      typeof input.client_identifier_unverified === "string" &&
      input.client_identifier_unverified.length > 0
        ? input.client_identifier_unverified
        : "unknown";
    let ids: { task_id: string; driver_state_id: string };
    try {
      ids = await withStateTransaction(input.project_dir, captureNow(), async (tx) => {
        const created = await initializeTask(tx, {
          project_dir: input.project_dir,
          task,
          task_short: null,
          owner_id: input.owner_id ?? "anonymous",
          ...(policyPreset !== undefined ? { policy_preset: policyPreset } : {}),
          ...(input.gate_policies !== undefined
            ? { gate_policies: input.gate_policies as Record<GateRole, PolicyName> }
            : {}),
          ...(input.complexity_hint !== undefined
            ? { complexity_hint: input.complexity_hint }
            : {}),
          ...(input.tests_mode_hint !== undefined
            ? { tests_mode_hint: input.tests_mode_hint }
            : {}),
          stack: input.stack ?? null,
          client_idempotency_uuid: input.client_idempotency_uuid,
          phases: registry.bundle.phases,
          flow_name: "standard",
        });
        await writeAuditRow(tx, "pipeline_run_task", created.task_id, created.driver_state_id, {
          client_identifier_unverified: identifier,
        });
        return created;
      });
    } catch (err) {
      return refusal(err);
    }

    // 6. Load state, run the FSM to its first directive, shape it.
    const loaded = await readState(input.project_dir);
    const { directive } = await runFSM(loaded, registry);
    const response = adapter.shape(directive, { driver_state_id: ids.driver_state_id });

    // 7. Materialize the cached creation response on the ledger row.
    await withStateTransaction(input.project_dir, captureNow(), async (tx) => {
      await writeLedgerRow(tx, `task-create:${input.client_idempotency_uuid}`, {
        driver_state_id: ids.driver_state_id,
        task_id: ids.task_id,
        response_blob: JSON.stringify(response),
      });
    });

    return {
      response,
      task_id: ids.task_id,
      driver_state_id: ids.driver_state_id,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  };
}

// Read the canonical state through a read-only TransactionImpl — the
// handler never commits this scope, so the now token threaded here is
// local and not observable on disk.
async function readState(projectDir: string) {
  const db = openDb(projectDir);
  const tx = new TransactionImpl(db, captureNow());
  return await loadState(tx);
}

async function readCachedCreation(
  projectDir: string,
  uuid: string,
): Promise<RunTaskResponse | null> {
  const db = openDb(projectDir);
  const tx = new TransactionImpl(db, captureNow());
  const row = await readLedgerRow(tx, `task-create:${uuid}`);
  if (row === null || row.response_blob === null) return null;
  const response = JSON.parse(row.response_blob) as TransportResponse;
  const ps = await tx.queryRow<{ task_id: unknown; driver_state_id: unknown }>(
    "SELECT task_id, driver_state_id FROM pipeline_state WHERE id = 1",
  );
  const out: RunTaskResponse = { response };
  if (ps !== null) {
    if (ps.task_id !== null) out.task_id = String(ps.task_id);
    out.driver_state_id = String(ps.driver_state_id);
  }
  return out;
}

async function writeAuditRow(
  tx: Transaction,
  type: string,
  taskId: string | null,
  driverStateId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.exec(
    "INSERT INTO audit (ts, type, task_id, driver_state_id, payload, verdict, error_class) " +
      "VALUES (?, ?, ?, ?, ?, 'ok', NULL)",
    [tx.now, type, taskId, driverStateId, JSON.stringify(payload)],
  );
}

// Map a thrown KernelError into an error-shaped wire envelope; rethrow
// anything that is not a kernel-coded refusal (programmer error).
function refusal(err: unknown): RunTaskResponse {
  if (err instanceof KernelError) {
    return { response: errorResponse(UNKNOWN_DRIVER, err.code, err.message) };
  }
  throw err;
}

function errorResponse(
  driverStateId: string,
  code: string,
  message: string,
): TransportResponse {
  return {
    status: "error",
    driver_state_id: driverStateId,
    code,
    message,
    recovery_options: [],
  };
}
