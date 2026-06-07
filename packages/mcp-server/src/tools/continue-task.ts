// pipeline_continue_task — delivery handler for agent results, fanout
// batches, and user answers.
//
// The stdio transport shell around the shared deliver composition:
// allowlist gate → variant refusals → ledger cache lookup → delegate to
// `deliverAndAdvance` (shared with the headless loop, so the honest server
// git delta, the co-committed audit + idempotency-ledger rows, the
// resume-point persist, and the next FSM tick are computed identically by
// every transport — no transport can silently drop the file-delta feed).
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
  openDb,
  readLedgerRow,
  TransactionImpl,
  type Registry,
} from "@loomfsm/kernel";
import { deliverAndAdvance, ledgerKeysFor } from "@loomfsm/driver";
import type { TransportResponse } from "@loomfsm/transport-types";

import { identifierOf, refuseTransport, transportError } from "../lib/refusal.js";
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
        response: transportError(
          driverStateId,
          "RECOVERY_VIA_CONTINUE_REFUSED",
          "recovery is delivered through the recovery primitive, not pipeline_continue_task",
        ),
      };
    }
    if (input.input.type === "agents-results" && input.input.partial === true) {
      return {
        response: transportError(
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
        response: transportError(
          driverStateId,
          "REGISTRY_UNAVAILABLE",
          "no registry resolver is wired for the active-task path",
        ),
      };
    }
    const registry = await deps.resolveRegistry(input.project_dir);

    const identifier = identifierOf(input);

    // 4. Delegate delivery + the next tick to the shared composition.
    try {
      const { response } = await deliverAndAdvance(input.project_dir, {
        registry,
        input: input.input,
        driver_state_id: driverStateId,
        identifier,
      });
      return { response };
    } catch (err) {
      return refusal(err, driverStateId);
    }
  };
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

function refusal(err: unknown, driverStateId: string): ContinueTaskResponse {
  return refuseTransport(err, driverStateId);
}
