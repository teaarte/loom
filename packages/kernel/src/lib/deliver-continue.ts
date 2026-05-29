// Continue-task delivery dispatcher — the variant router behind
// `pipeline_continue_task`.
//
// Each variant writes its op-shaped idempotency-ledger row (with
// `response_blob = null`) INSIDE the caller's tx alongside the state
// mutation it dedupes; the caller updates the row with the shaped wire
// envelope after the post-delivery FSM tick resolves, so a duplicate
// delivery returns the cached next-step response. A replay (ledger row
// already present) returns without re-persisting — no double counters
// bump, no double drain.
//
//   agent-result   — drain the pending row, persist the result, bump
//                    counters; advance the FSM step once the pending set
//                    for the spawn is fully drained.
//   agents-results — the per-result branch in a loop (one ledger row per
//                    agent_run_id); advance once every sibling drained.
//   user-answer    — record the gate decision, clear the pending answer,
//                    advance past the gate. Bound to the driver's issued
//                    gate_event_id (`GATE_EVENT_STALE` on mismatch).
//
// `recovery` is refused here — it is delivered through the recovery
// primitive, not this surface.
//
// Wall-clock discipline: every timestamp comes from `tx.now`.

import { KernelError } from "../state/db.js";
import { assertVocabKnown } from "../vocabularies.js";
import type { ContinueTaskInput } from "../types/continue-task.js";
import type { AgentOutputKind } from "../types/plugins.js";
import type { Transaction } from "../types/transaction.js";
import type { KernelVocabularies } from "../types/vocabulary.js";

import { buildAgentResult } from "./build-agent-result.js";
import { readLedgerRow, writeLedgerRow } from "./ledger.js";
import { persistAgentResult } from "./persist-agent-result.js";

export interface DeliverContinueArgs {
  input: ContinueTaskInput;
  driver_state_id: string;
  // Resolve an agent's output_kind so the persistor knows whether to
  // extract findings / verdicts. Defaults to "nonreview" when the
  // resolver is absent or returns undefined.
  resolveOutputKind?: (agent: string) => AgentOutputKind | undefined;
  // Registry vocabularies for insert-time validation. Threaded to the
  // persistor (`agent_records.output_kind`) and consulted for the gate
  // decision's `decided_by`. Optional for the same reason
  // `resolveOutputKind` is — the production delivery path supplies it.
  vocabularies?: KernelVocabularies;
}

export async function deliverContinue(
  tx: Transaction,
  args: DeliverContinueArgs,
): Promise<void> {
  const { input } = args;
  switch (input.type) {
    case "agent-result": {
      const delivered = await deliverAgentResult(
        tx,
        args,
        input.agent_run_id,
        input.agent_output,
      );
      // A pure replay (ledger row already present) is a no-op — it must
      // NOT advance the step a second time, or the FSM walks past the
      // next stage on every retried delivery.
      if (delivered) await advanceIfDrained(tx);
      return;
    }
    case "agents-results": {
      if (input.partial === true) {
        throw new KernelError({
          code: "PARTIAL_FANOUT_REFUSED",
          message: "partial fanout delivery is not accepted on this surface",
        });
      }
      let anyDelivered = false;
      for (const result of input.results) {
        const delivered = await deliverAgentResult(
          tx,
          args,
          result.agent_run_id,
          result.agent_output,
        );
        anyDelivered = anyDelivered || delivered;
      }
      if (anyDelivered) await advanceIfDrained(tx);
      return;
    }
    case "user-answer": {
      await deliverUserAnswer(tx, args, input);
      return;
    }
    case "recovery": {
      throw new KernelError({
        code: "RECOVERY_VIA_CONTINUE_REFUSED",
        message: "recovery is delivered through the recovery primitive, not continue",
      });
    }
    default: {
      const _exhaustive: never = input;
      return _exhaustive;
    }
  }
}

// Returns true when this call actually persisted a delivery; false on a
// pure replay (so the caller knows whether to advance the FSM step).
async function deliverAgentResult(
  tx: Transaction,
  args: DeliverContinueArgs,
  agentRunId: string,
  agentOutput: string,
): Promise<boolean> {
  const key = `agent-result:${agentRunId}`;
  const existing = await readLedgerRow(tx, key);
  if (existing !== null) return false; // replay — already delivered

  const pending = await tx.queryRow<{ agent: unknown; phase: unknown; model: unknown }>(
    "SELECT agent, phase, model FROM pending_agents WHERE agent_run_id = ?",
    [agentRunId],
  );
  if (pending === null) {
    throw new KernelError({
      code: "PENDING_AGENT_NOT_FOUND",
      message: `no pending_agents row for agent_run_id '${agentRunId}'`,
      detail: { agent_run_id: agentRunId },
    });
  }
  const agent = String(pending.agent);
  const phase = String(pending.phase);
  const model = pending.model === null ? null : String(pending.model);
  const outputKind: AgentOutputKind =
    args.resolveOutputKind?.(agent) ?? "nonreview";

  const result = buildAgentResult({
    agent,
    agent_run_id: agentRunId,
    output_kind: outputKind,
    raw_output: agentOutput,
  });
  await persistAgentResult(tx, {
    result,
    output_kind: outputKind,
    phase,
    model,
    ...(args.vocabularies !== undefined ? { vocabularies: args.vocabularies } : {}),
  });

  const taskId = await readTaskId(tx);
  await writeLedgerRow(tx, key, {
    driver_state_id: args.driver_state_id,
    task_id: taskId,
    response_blob: null,
  });
  return true;
}

async function deliverUserAnswer(
  tx: Transaction,
  args: DeliverContinueArgs,
  input: Extract<ContinueTaskInput, { type: "user-answer" }>,
): Promise<void> {
  const key = `user-answer:${input.gate_event_id}`;
  const existing = await readLedgerRow(tx, key);
  if (existing !== null) return; // replay — already delivered

  const driverRow = await tx.queryRow<{ pending_user_answer: unknown }>(
    "SELECT pending_user_answer FROM driver_state WHERE id = 1",
  );
  const pending = parsePendingUserAnswer(driverRow?.pending_user_answer ?? null);
  if (pending === null || pending.gate_event_id !== input.gate_event_id) {
    throw new KernelError({
      code: "GATE_EVENT_STALE",
      message: `gate_event_id '${input.gate_event_id}' was not issued for driver_state_id '${args.driver_state_id}'`,
      detail: { gate_event_id: input.gate_event_id, driver_state_id: args.driver_state_id },
    });
  }

  const status = input.decision === "reject" ? "rejected" : "approved";
  // A human-answered gate is recorded `decided_by = "human"`. Validate
  // the value against the merged vocabulary before it lands so the
  // `decided_by` column stays inside the declared set — the same
  // insert-time discipline the other enum columns get.
  const decidedBy = "human";
  if (args.vocabularies !== undefined) {
    assertVocabKnown(args.vocabularies.decided_by, decidedBy, "decided_by");
  }
  await tx.exec(
    "INSERT INTO gates (name, status, decided_by, feedback, decided_at) " +
      "VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(name) DO UPDATE SET " +
      "status = excluded.status, decided_by = excluded.decided_by, " +
      "feedback = excluded.feedback, decided_at = excluded.decided_at",
    [pending.gate, status, decidedBy, input.message ?? null, tx.now],
  );

  await tx.exec(
    "UPDATE driver_state SET pending_user_answer = NULL, step_index = step_index + 1 WHERE id = 1",
  );

  const taskId = await readTaskId(tx);
  await writeLedgerRow(tx, key, {
    driver_state_id: args.driver_state_id,
    task_id: taskId,
    response_blob: null,
  });
}

// Advance past the satisfied spawn / fanout stage once its pending set
// is fully drained — a single spawn drains to empty on its one result;
// a fanout advances only when every sibling has been delivered.
async function advanceIfDrained(tx: Transaction): Promise<void> {
  const row = await tx.queryRow<{ c: unknown }>(
    "SELECT COUNT(*) AS c FROM pending_agents",
  );
  const remaining = row === null ? 0 : Number(row.c);
  if (remaining === 0) {
    await tx.exec("UPDATE driver_state SET step_index = step_index + 1 WHERE id = 1");
  }
}

async function readTaskId(tx: Transaction): Promise<string | null> {
  const row = await tx.queryRow<{ task_id: unknown }>(
    "SELECT task_id FROM pipeline_state WHERE id = 1",
  );
  if (row === null || row.task_id === null) return null;
  return String(row.task_id);
}

interface PendingUserAnswer {
  gate: string;
  gate_event_id?: string;
}

function parsePendingUserAnswer(raw: unknown): PendingUserAnswer | null {
  if (raw === null || raw === undefined) return null;
  const text = typeof raw === "string" ? raw : String(raw);
  if (text.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const gate = typeof obj["gate"] === "string" ? (obj["gate"] as string) : null;
  if (gate === null) return null;
  const out: PendingUserAnswer = { gate };
  if (typeof obj["gate_event_id"] === "string") {
    out.gate_event_id = obj["gate_event_id"] as string;
  }
  return out;
}
