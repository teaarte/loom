// pipeline_recover — the five-choice recovery surface.
//
// Composition mirrors pipeline_continue_task: project-dir allowlist gate
// → owner comparison → ledger replay lookup → recover inside one
// withStateTransaction (the recovery-keyed ledger row + a co-committed
// audit row land with the state mutation) → for the re-entrant choices
// (retry / retry-failed / cancel-pending) load state and run the FSM to
// the next directive; for the terminal choices (abandon / force-close)
// shape the terminal response directly → materialize the cached response
// on the ledger row.
//
// recovery_id is server-issued: omit it on the first call (the kernel
// mints one and returns it); pass it back to replay the cached response
// verbatim; omit it to issue a NEW recovery action. The response always
// carries the (minted-or-supplied) recovery_id so a client retry is
// keyable — even when the response is an error envelope.
//
// Cross-owner recovery is refused with CROSS_OWNER_MARKER_REQUIRED: the
// owner_id comparison is the only owner check this surface performs — the
// bypass-marker acceptance path is a separate concern and is not reached
// here.
//
// Refusals (allowlist, owner mismatch, invalid/stale/terminal recovery,
// missing registry) are error-shaped wire envelopes; only programmer
// errors throw.

import {
  assertProjectDirAllowed,
  captureNow,
  KernelError,
  loadState,
  makeRecoveryId,
  openDb,
  readLedgerRow,
  recoverTask,
  runFSM,
  TransactionImpl,
  withStateTransaction,
  writeLedgerRow,
  type Registry,
  type Transaction,
} from "@loom/kernel";
import type { TransportResponse } from "@loom/transport-types";

import { createTransportAdapter } from "../transport-adapter.js";
import type {
  RecoverTaskInput,
  RecoverTaskResponse,
  RecoveryChoiceInput,
  ToolHandler,
} from "../types.js";

export interface RecoverDeps {
  resolveRegistry?: (projectDir: string) => Promise<Registry> | Registry;
  allowlistPath?: string;
}

const REENTRANT: ReadonlySet<RecoveryChoiceInput> = new Set<RecoveryChoiceInput>([
  "retry",
  "retry-failed",
  "cancel-pending",
]);

const DEFAULT_OWNER = "anonymous";

export function createRecoverTool(
  deps: RecoverDeps = {},
): ToolHandler<RecoverTaskInput, RecoverTaskResponse> {
  const adapter = createTransportAdapter();

  return async (input) => {
    const driverStateId = input.driver_state_id;
    // recovery_id is resolved BEFORE any work so every exit path — refusal
    // or success — echoes a keyable id back to the caller.
    const recoveryId = resolveRecoveryId(input.recovery_id);

    // 1. Project-dir allowlist.
    try {
      await assertProjectDirAllowed(
        input.project_dir,
        deps.allowlistPath !== undefined ? { allowlistPath: deps.allowlistPath } : undefined,
      );
    } catch (err) {
      return refusal(err, driverStateId, recoveryId);
    }

    // 2. Owner comparison. A row owner_id that is set and differs from the
    //    caller refuses cross-owner recovery; the marker path is separate.
    const callerOwner =
      typeof input.owner_id === "string" && input.owner_id.length > 0
        ? input.owner_id
        : DEFAULT_OWNER;
    let ownerCheck: { code: string; message: string } | null;
    try {
      ownerCheck = await checkOwner(input.project_dir, callerOwner);
    } catch (err) {
      return refusal(err, driverStateId, recoveryId);
    }
    if (ownerCheck !== null) {
      return {
        response: errorResponse(driverStateId, ownerCheck.code, ownerCheck.message),
        recovery_id: recoveryId,
      };
    }

    // 3. Replay — a materialized ledger blob for this exact recovery action
    //    replays the cached envelope verbatim (same recovery_id echoed).
    const ledgerKey = `recovery:${driverStateId}:${input.choice}:${recoveryId}`;
    const cached = await readCachedRecovery(input.project_dir, ledgerKey);
    if (cached !== null) {
      return { response: cached, recovery_id: recoveryId };
    }

    // 4. The re-entrant choices need a flow to tick; without a registry
    //    they refuse. Terminal choices (abandon / force-close) shape a
    //    terminal response with no FSM tick, so they proceed regardless.
    const reentrant = REENTRANT.has(input.choice);
    if (reentrant && deps.resolveRegistry === undefined) {
      return {
        response: errorResponse(
          driverStateId,
          "REGISTRY_UNAVAILABLE",
          "no registry resolver is wired for the re-entrant recovery path",
        ),
        recovery_id: recoveryId,
      };
    }

    const identifier =
      typeof input.client_identifier_unverified === "string" &&
      input.client_identifier_unverified.length > 0
        ? input.client_identifier_unverified
        : "unknown";

    // 5. Recover + co-committed audit row.
    let result: { recovery_id: string; reenter: boolean };
    try {
      result = await withStateTransaction(input.project_dir, captureNow(), async (tx) => {
        const recovered = await recoverTask(tx, {
          driver_state_id: driverStateId,
          choice: input.choice,
          ...(input.agent_run_ids !== undefined ? { agent_run_ids: input.agent_run_ids } : {}),
          recovery_id: recoveryId,
        });
        const taskId = await readTaskId(tx);
        await writeAuditRow(tx, "pipeline_recover", taskId, driverStateId, {
          client_identifier_unverified: identifier,
          choice: input.choice,
          recovery_id: recoveryId,
        });
        return recovered;
      });
    } catch (err) {
      return refusal(err, driverStateId, recoveryId);
    }

    // 6. Shape the response: re-entrant choices resume the FSM; terminal
    //    choices read the now-closed state and shape directly. The
    //    recovery has already committed, so a kernel-coded failure of the
    //    post-recovery FSM tick (e.g. a still-pending row that cannot be
    //    re-shuttled inside the spawn duplicate-window) is shaped as an
    //    error envelope, not thrown — the cached envelope makes a replay
    //    return the same outcome.
    let response: TransportResponse;
    if (result.reenter) {
      try {
        const registry = await deps.resolveRegistry!(input.project_dir);
        const loaded = await readState(input.project_dir);
        const { directive } = await runFSM(loaded, registry);
        response = adapter.shape(directive, { driver_state_id: driverStateId });
      } catch (err) {
        if (!(err instanceof KernelError)) throw err;
        response = errorResponse(driverStateId, err.code, err.message);
      }
    } else {
      response = await terminalResponse(input.project_dir, input.choice);
    }

    // 7. Materialize the cached response on the recovery ledger row.
    await withStateTransaction(input.project_dir, captureNow(), async (tx) => {
      const taskId = await readTaskId(tx);
      await writeLedgerRow(tx, ledgerKey, {
        driver_state_id: driverStateId,
        task_id: taskId,
        response_blob: JSON.stringify(response),
      });
    });

    return { response, recovery_id: recoveryId };
  };
}

function resolveRecoveryId(supplied: string | undefined): string {
  if (typeof supplied === "string" && supplied.length > 0) return supplied;
  return makeRecoveryId();
}

// Compare the caller owner against the stored owner_id. Returns a refusal
// shape on cross-owner mismatch, or null when recovery may proceed (row
// owner null, equal, or no task yet — recoverTask surfaces a missing task).
async function checkOwner(
  projectDir: string,
  callerOwner: string,
): Promise<{ code: string; message: string } | null> {
  const db = openDb(projectDir);
  const tx = new TransactionImpl(db, captureNow());
  const row = await tx.queryRow<{ owner_id: unknown }>(
    "SELECT owner_id FROM pipeline_state WHERE id = 1",
  );
  if (row === null || row.owner_id === null) return null;
  const rowOwner = String(row.owner_id);
  if (rowOwner === callerOwner) return null;
  return {
    code: "CROSS_OWNER_MARKER_REQUIRED",
    message: `recovery of a task owned by '${rowOwner}' requires an owner bypass marker`,
  };
}

async function readCachedRecovery(
  projectDir: string,
  key: string,
): Promise<TransportResponse | null> {
  const db = openDb(projectDir);
  const tx = new TransactionImpl(db, captureNow());
  const row = await readLedgerRow(tx, key);
  if (row === null || row.response_blob === null) return null;
  return JSON.parse(row.response_blob) as TransportResponse;
}

async function terminalResponse(
  projectDir: string,
  choice: RecoveryChoiceInput,
): Promise<TransportResponse> {
  const db = openDb(projectDir);
  const tx = new TransactionImpl(db, captureNow());
  const taskId = await readTaskId(tx);
  if (choice === "force-close") {
    return {
      status: "complete",
      task_id: taskId,
      verdict: "failed_force_closed",
      summary: "task force-closed via recovery",
    };
  }
  // abandon — the canonical pipeline verdict is NULL (status='abandoned').
  // The wire `complete` form has no abandoned/null verdict, so the wire
  // verdict maps to 'rejected' (the abandon-intent terminal); the stored
  // verdict stays NULL and is distinct from a force-close.
  return {
    status: "complete",
    task_id: taskId,
    verdict: "rejected",
    summary: "task abandoned via recovery",
  };
}

async function readState(projectDir: string) {
  const db = openDb(projectDir);
  const tx = new TransactionImpl(db, captureNow());
  return await loadState(tx);
}

async function readTaskId(tx: Transaction): Promise<string | null> {
  const row = await tx.queryRow<{ task_id: unknown }>(
    "SELECT task_id FROM pipeline_state WHERE id = 1",
  );
  if (row === null || row.task_id === null) return null;
  return String(row.task_id);
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

function refusal(
  err: unknown,
  driverStateId: string,
  recoveryId: string,
): RecoverTaskResponse {
  if (err instanceof KernelError) {
    return {
      response: errorResponse(driverStateId, err.code, err.message),
      recovery_id: recoveryId,
    };
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
