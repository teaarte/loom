// pipeline_run_task — task-create handler.
//
// This is the stdio transport shell around the shared create composition:
//   1. assertProjectDirAllowed — refusal lands as an error-shaped wire
//      envelope, NOT a thrown exception.
//   2. Validate client_idempotency_uuid — empty → error envelope.
//   3. Ledger cache lookup — a `task-create:<uuid>` row carrying a
//      materialized response_blob replays the cached creation envelope
//      verbatim (same task_id / driver_state_id, read off the canonical
//      pipeline_state row).
//   3b. Free a finished slot before creating the next task — the
//      belt-and-suspenders path for a user who never ran the graceful
//      finish. An in-progress task is NEVER auto-rotated; the create tx
//      refuses it with a typed PROJECT_TASK_ACTIVE error.
//   4. Parse the raw task string when no policy_preset was supplied.
//   5. Delegate the atomic create + first FSM tick to `createAndStart`
//      (shared with the headless loop, so both produce an identical first
//      envelope + cached creation ledger row).
//
// Operational failures (allowlist refusal, missing UUID, kernel-coded
// refusals) become structured error envelopes; the MCP client sees the
// same wire shape for a refusal as for the happy path. Only programmer
// errors throw.

import {
  archiveStateDb,
  assertProjectDirAllowed,
  captureNow,
  KernelError,
  openDb,
  peekArchiveSlot,
  readLedgerRow,
  TransactionImpl,
  type GateRole,
  type PolicyName,
  type Registry,
} from "@loomfsm/kernel";
import { createAndStart } from "@loomfsm/driver";
import type { TransportResponse } from "@loomfsm/transport-types";

import { parseTaskArgs } from "../lib/parse-task-args.js";
import type { RunTaskInput, RunTaskResponse, ToolHandler } from "../types.js";

export interface RunTaskDeps {
  // Resolve the FSM registry for a project. Production wiring imports the
  // active bundle and assembles the registry; tests inject a ready one.
  // Absent → the handler refuses with a structured error envelope.
  resolveRegistry?: (projectDir: string) => Promise<Registry> | Registry;
  // Allowlist file override threaded to assertProjectDirAllowed. Tests
  // point at a tmpfile; production omits it and gets the default.
  allowlistPath?: string;
}

const UNKNOWN_DRIVER = "d-unknown";

export function createRunTaskTool(
  deps: RunTaskDeps = {},
): ToolHandler<RunTaskInput, RunTaskResponse> {
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

    // 3b. Free a finished slot before creating the next task.
    try {
      const slot = await peekArchiveSlot(input.project_dir);
      if (slot !== null && (slot.status === "completed" || slot.status === "abandoned")) {
        await archiveStateDb(input.project_dir, captureNow(), { reason: "auto-rotate" });
      }
    } catch (err) {
      return refusal(err);
    }

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

    const identifier =
      typeof input.client_identifier_unverified === "string" &&
      input.client_identifier_unverified.length > 0
        ? input.client_identifier_unverified
        : "unknown";

    // 5. Delegate the atomic create + first tick to the shared composition.
    try {
      const created = await createAndStart(input.project_dir, {
        registry,
        task,
        client_idempotency_uuid: input.client_idempotency_uuid,
        owner_id: input.owner_id ?? "anonymous",
        ...(policyPreset !== undefined ? { policy_preset: policyPreset } : {}),
        ...(input.gate_policies !== undefined
          ? { gate_policies: input.gate_policies as Partial<Record<GateRole, PolicyName>> }
          : {}),
        ...(input.complexity_hint !== undefined ? { complexity_hint: input.complexity_hint } : {}),
        ...(input.tests_mode_hint !== undefined ? { tests_mode_hint: input.tests_mode_hint } : {}),
        stack: input.stack ?? null,
        identifier,
      });
      return {
        response: created.response,
        task_id: created.task_id,
        driver_state_id: created.driver_state_id,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    } catch (err) {
      return refusal(err);
    }
  };
}

// Read the canonical creation envelope cached on the task-create ledger
// row. The handler never commits this scope, so the now token threaded
// here is local and not observable on disk.
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
