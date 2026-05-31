// pipeline_recover — the five-choice recovery surface.
//
// Composition mirrors pipeline_continue_task: project-dir allowlist gate
// → ledger replay lookup → recover inside one withStateTransaction (the
// owner check + the recovery-keyed ledger row + a co-committed audit row
// land with the state mutation) → for the re-entrant choices (retry /
// retry-failed / cancel-pending) resolve the next directive; for the
// terminal choices (abandon / force-close) shape the terminal response
// directly → materialize the cached response on the ledger row.
//
// Owner check + cross-owner marker: the owner comparison runs INSIDE the
// recovery tx via `ownerCheckGuard`. Same-owner / unclaimed tasks pass
// untouched. A cross-owner recovery is refused with CROSS_OWNER_REQUIRED
// unless the caller presents a signed `marker`; a presented marker is
// verified (signature, target, expiry, key) and CONSUMED in the same tx
// as the recovery — no read-then-act window. `client_identifier_unverified`
// stays forensics-only (the kernel never branches on it).
//
// retry-failed: the named pending rows are re-shuttled reusing their
// existing agent_run_id (no fresh begin_spawn → no duplicate-window
// trip), gated on provider idempotency — a non-idempotent provider is
// refused with PROVIDER_NOT_IDEMPOTENT.
//
// recovery_id is server-issued: omit it on the first call (the kernel
// mints one and returns it); pass it back to replay the cached response
// verbatim; omit it to issue a NEW recovery action. The response always
// carries the (minted-or-supplied) recovery_id so a client retry is
// keyable — even when the response is an error envelope.
//
// Refusals (allowlist, owner / marker, invalid/stale/terminal recovery,
// missing registry) are error-shaped wire envelopes; only programmer
// errors throw.

import {
  assertProjectDirAllowed,
  buildRetryFailedDirective,
  captureNow,
  KernelError,
  loadState,
  makeRecoveryId,
  openDb,
  ownerCheckGuard,
  readLedgerRow,
  recoverTask,
  runFSM,
  TransactionImpl,
  withStateTransaction,
  writeLedgerRow,
  type BypassMarker,
  type NowToken,
  type Registry,
  type RecoveryOutcome,
  type Transaction,
} from "@loomfsm/kernel";
import type { TransportResponse } from "@loomfsm/transport-types";

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

    const callerOwner =
      typeof input.owner_id === "string" && input.owner_id.length > 0
        ? input.owner_id
        : DEFAULT_OWNER;
    const marker = toBypassMarker(input.marker);

    // 2. Replay — a materialized ledger blob for this exact recovery action
    //    replays the cached envelope verbatim (same recovery_id echoed).
    const ledgerKey = `recovery:${driverStateId}:${input.choice}:${recoveryId}`;
    const cached = await readCachedRecovery(input.project_dir, ledgerKey);
    if (cached !== null) {
      return { response: cached, recovery_id: recoveryId };
    }

    // 3. The re-entrant choices need a flow to tick; without a registry
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

    // 4. Owner check + recover + co-committed audit row, all in one tx. The
    //    cross-owner marker (if any) is verified and CONSUMED here, atomic
    //    with the recovery it authorizes.
    let result: { recovery_id: string; reenter: boolean; outcome: RecoveryOutcome };
    try {
      result = await withStateTransaction(input.project_dir, captureNow(), async (tx) => {
        await ownerCheckGuard(
          tx,
          { driver_state_id: driverStateId, caller_owner_id: callerOwner },
          marker,
        );
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
        }, outcomeErrorClass(recovered.outcome));
        return recovered;
      });
    } catch (err) {
      return refusal(err, driverStateId, recoveryId);
    }

    // 5. Shape the response: re-entrant choices resume the FSM (retry /
    //    cancel-pending) or re-shuttle the named pending rows (retry-failed);
    //    terminal choices read the now-closed state and shape directly. The
    //    recovery has already committed, so a kernel-coded failure of the
    //    re-entry (e.g. PROVIDER_NOT_IDEMPOTENT on a retry-failed against a
    //    non-idempotent provider) is shaped as an error envelope, not
    //    thrown — the cached envelope makes a replay return the same outcome.
    let response: TransportResponse;
    if (result.reenter) {
      try {
        const registry = await deps.resolveRegistry!(input.project_dir);
        const loaded = await readState(input.project_dir);
        if (input.choice === "retry-failed") {
          const directive = buildRetryFailedDirective(
            loaded,
            registry,
            input.agent_run_ids ?? [],
          );
          response = adapter.shape(directive, { driver_state_id: driverStateId });
        } else {
          const { directive } = await runFSM(loaded, registry);
          response = adapter.shape(directive, { driver_state_id: driverStateId });
        }
      } catch (err) {
        if (!(err instanceof KernelError)) throw err;
        response = errorResponse(driverStateId, err.code, err.message);
      }
    } else {
      response = await terminalResponse(input.project_dir, input.choice);
    }

    // 6. Materialize the cached response on the recovery ledger row.
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

// Map the wire marker (plain strings) onto the kernel BypassMarker
// (NowToken-branded timestamps). The kernel re-derives the HMAC and
// verifies it — a tampered field simply fails the signature check.
function toBypassMarker(
  input: RecoverTaskInput["marker"],
): BypassMarker | undefined {
  if (input === undefined) return undefined;
  return {
    issued_at: input.issued_at as NowToken,
    expires_at: input.expires_at as NowToken,
    reason: input.reason,
    hmac: input.hmac,
    key_id: input.key_id,
  };
}

// The forensic recovery outcome maps to the audit error_class: an
// idempotent / raced recovery is a successful no-op tagged for forensics,
// not a failure — verdict stays 'ok' and the tag rides on error_class.
function outcomeErrorClass(outcome: RecoveryOutcome): string | null {
  switch (outcome) {
    case "idempotent":
      return "recovery-idempotent";
    case "raced":
      return "recovery-raced";
    case "applied":
      return null;
  }
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
  errorClass: string | null,
): Promise<void> {
  await tx.exec(
    "INSERT INTO audit (ts, type, task_id, driver_state_id, payload, verdict, error_class) " +
      "VALUES (?, ?, ?, ?, ?, 'ok', ?)",
    [tx.now, type, taskId, driverStateId, JSON.stringify(payload), errorClass],
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
