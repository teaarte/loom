// pipeline_continue_task — delivery handler for agent results, fanout
// batches, and user answers.
//
// Composition mirrors pipeline_run_task: allowlist gate → variant
// refusals → ledger cache lookup → deliver inside one withStateTransaction
// (the op-shaped ledger row + a co-committed audit row land with the
// state mutation) → run the FSM against the post-delivery state → shape
// the next directive → materialize the cached response on the ledger
// row(s).
//
// Two variants are refused on this surface:
//   recovery       → RECOVERY_VIA_CONTINUE_REFUSED (its own primitive).
//   agents-results with partial:true → PARTIAL_FANOUT_REFUSED.
//
// Refusals (allowlist, variant, kernel-coded errors like GATE_EVENT_STALE)
// become error-shaped wire envelopes; only programmer errors throw.

import {
  assertProjectDirAllowed,
  captureNow,
  deliverContinue,
  KernelError,
  loadState,
  openDb,
  readLedgerRow,
  runFSM,
  TransactionImpl,
  withStateTransaction,
  writeLedgerRow,
  type Registry,
  type Transaction,
} from "@loomfsm/kernel";
import type { TransportResponse } from "@loomfsm/transport-types";

import { persistDriverStepIndex } from "../lib/persist-progress.js";
import { createTransportAdapter } from "../transport-adapter.js";
import type {
  ContinueTaskRequestInput,
  ContinueTaskResponse,
  ToolHandler,
} from "../types.js";

export interface ContinueTaskDeps {
  resolveRegistry?: (projectDir: string) => Promise<Registry> | Registry;
  allowlistPath?: string;
}

export function createContinueTaskTool(
  deps: ContinueTaskDeps = {},
): ToolHandler<ContinueTaskRequestInput, ContinueTaskResponse> {
  const adapter = createTransportAdapter();

  return async (input) => {
    const driverStateId = input.driver_state_id;

    // 1. Project-dir allowlist.
    try {
      await assertProjectDirAllowed(
        input.project_dir,
        deps.allowlistPath !== undefined ? { allowlistPath: deps.allowlistPath } : undefined,
      );
    } catch (err) {
      return refusal(err, driverStateId);
    }

    // 2. Variant refusals handled on this surface.
    if (input.input.type === "recovery") {
      return {
        response: errorResponse(
          driverStateId,
          "RECOVERY_VIA_CONTINUE_REFUSED",
          "recovery is delivered through the recovery primitive, not pipeline_continue_task",
        ),
      };
    }
    if (input.input.type === "agents-results" && input.input.partial === true) {
      return {
        response: errorResponse(
          driverStateId,
          "PARTIAL_FANOUT_REFUSED",
          "partial fanout delivery is not accepted on this surface",
        ),
      };
    }

    // 3. Replay — a materialized ledger blob under any of the op keys
    //    replays the cached next-step envelope verbatim.
    const keys = ledgerKeysFor(input.input);
    const cached = await readCachedDelivery(input.project_dir, keys);
    if (cached !== null) return { response: cached };

    if (deps.resolveRegistry === undefined) {
      return {
        response: errorResponse(
          driverStateId,
          "REGISTRY_UNAVAILABLE",
          "no registry resolver is wired for the active-task path",
        ),
      };
    }
    const registry = await deps.resolveRegistry(input.project_dir);

    const identifier =
      typeof input.client_identifier_unverified === "string" &&
      input.client_identifier_unverified.length > 0
        ? input.client_identifier_unverified
        : "unknown";

    // 4. Deliver + co-committed audit row.
    try {
      await withStateTransaction(input.project_dir, captureNow(), async (tx) => {
        await deliverContinue(tx, {
          input: input.input,
          driver_state_id: driverStateId,
          resolveOutputKind: (agent) => registry.agents.get(agent)?.output_kind,
          vocabularies: registry.vocabularies,
          // The human-answer path resolves the gate's on_resume + the active
          // flow from here, so a revise walks back and an abandon completes
          // rejected instead of advancing like an accept.
          registry,
        });
        const taskId = await readTaskId(tx);
        await writeAuditRow(tx, "pipeline_continue_task", taskId, driverStateId, {
          client_identifier_unverified: identifier,
        });
      });
    } catch (err) {
      return refusal(err, driverStateId);
    }

    // 5. Run the FSM against the post-delivery state and shape it.
    const loaded = await readState(input.project_dir);
    const { state: ticked, directive } = await runFSM(loaded, registry);
    const response = adapter.shape(directive, { driver_state_id: driverStateId });

    // 6. Persist the tick's paused step index + materialize the cached
    //    response on every op key (the fanout batch shares one envelope
    //    across all its agent_run_ids), co-committed.
    const taskId = loaded.task_id;
    await withStateTransaction(input.project_dir, captureNow(), async (tx) => {
      await persistDriverStepIndex(tx, ticked.driver.step_index);
      for (const key of keys) {
        await writeLedgerRow(tx, key, {
          driver_state_id: driverStateId,
          task_id: taskId,
          response_blob: JSON.stringify(response),
        });
      }
    });

    return { response };
  };
}

function ledgerKeysFor(input: ContinueTaskRequestInput["input"]): string[] {
  switch (input.type) {
    case "agent-result":
      return [`agent-result:${input.agent_run_id}`];
    case "agents-results":
      return input.results.map((r) => `agent-result:${r.agent_run_id}`);
    case "user-answer":
      return [`user-answer:${input.gate_event_id}`];
    case "recovery":
      return [];
    default: {
      const _exhaustive: never = input;
      return _exhaustive;
    }
  }
}

async function readState(projectDir: string) {
  const db = openDb(projectDir);
  const tx = new TransactionImpl(db, captureNow());
  return await loadState(tx);
}

async function readCachedDelivery(
  projectDir: string,
  keys: string[],
): Promise<TransportResponse | null> {
  if (keys.length === 0) return null;
  const db = openDb(projectDir);
  const tx = new TransactionImpl(db, captureNow());
  for (const key of keys) {
    const row = await readLedgerRow(tx, key);
    if (row !== null && row.response_blob !== null) {
      return JSON.parse(row.response_blob) as TransportResponse;
    }
  }
  return null;
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

function refusal(err: unknown, driverStateId: string): ContinueTaskResponse {
  if (err instanceof KernelError) {
    return { response: errorResponse(driverStateId, err.code, err.message) };
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
