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

import { buildStageContext } from "../fsm.js";
import { KernelError } from "../state/db.js";
import { loadState } from "../state/load.js";
import { assertVocabKnown } from "../vocabularies.js";
import type { ContinueTaskInput } from "../types/continue-task.js";
import type { AgentOutputKind, StageResult } from "../types/plugins.js";
import type { Registry } from "../types/registry.js";
import type { PipelineState } from "../types/state.js";
import type { Transaction } from "../types/transaction.js";
import type { UserAnswer } from "../types/user-answer.js";
import type { KernelVocabularies } from "../types/vocabulary.js";

import { applyBundleOps } from "./apply-bundle-ops.js";
import { buildAgentResult } from "./build-agent-result.js";
import { completeTask } from "./complete-task.js";
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
  // Full registry — required for the human-answer path to resolve the
  // gate stage's `on_resume` and the active flow (for a `walk_back_to`
  // target). When absent (hand-built fixtures that don't thread one), the
  // user-answer path falls back to a bare advance; production transports
  // always supply it so human revise/abandon honor the gate's resume.
  registry?: Registry;
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
      // File accounting unions in only on a real (non-replay) delivery —
      // a retried delivery must not re-merge, though the union is itself
      // idempotent.
      if (delivered) {
        await mergeDeliveredFiles(tx, input.files_modified, input.files_created);
      }
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
        if (delivered) {
          await mergeDeliveredFiles(tx, result.files_modified, result.files_created);
        }
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

  const state = await loadState(tx);
  const pending = state.driver.pending_user_answer;
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

  // Honor the gate's on_resume: a human "revise"/"abandon" must walk back
  // or complete-reject, NOT advance like an accept. Resolve the result the
  // answer drives and apply it (advance / walk_back / complete) inside this
  // delivery tx — co-committed with the gate row + the ledger row.
  const answer: UserAnswer = { decision: input.decision };
  if (input.reject_intent !== undefined) answer.reject_intent = input.reject_intent;
  if (input.message !== undefined) answer.message = input.message;

  const result = await resolveGateResume(tx, args, state, pending.gate, answer);
  await applyGateResult(tx, args, state, result);

  const taskId = await readTaskId(tx);
  await writeLedgerRow(tx, key, {
    driver_state_id: args.driver_state_id,
    task_id: taskId,
    response_blob: null,
  });
}

// Resolve the StageResult a human gate answer drives. With a registry
// threaded, runs the gate stage's `on_resume` (or the no-on_resume default:
// accept→advance, reject→walk_back to the gate); without one (hand-built
// fixtures), falls back to a bare advance — the legacy behavior.
async function resolveGateResume(
  tx: Transaction,
  args: DeliverContinueArgs,
  state: PipelineState,
  gateName: string,
  answer: UserAnswer,
): Promise<StageResult> {
  const registry = args.registry;
  if (registry === undefined) return { type: "advance" };

  const stage = registry.stages.get(gateName);
  if (stage === undefined || stage.kind !== "gate") return { type: "advance" };

  if (stage.on_resume === undefined) {
    if (answer.decision === "accept") return { type: "advance" };
    return {
      type: "walk_back_to",
      step: gateName,
      reason: "reject without bundle-supplied on_resume",
    };
  }

  const { ctx, ops } = await buildStageContext(state, registry, tx);
  const result = await stage.on_resume(ctx.state, answer, ctx);
  // Drain ops the resume body may have pushed (the code bundle's resumes
  // push none, but a general resume may set decisions / bundle_state).
  if (ops.length > 0) {
    await applyBundleOps(tx, ops, stage.phase);
    ops.length = 0;
  }
  return result;
}

// Apply a gate-resume StageResult inside the delivery tx. Clears the
// pending answer in every branch so the parked gate is released.
async function applyGateResult(
  tx: Transaction,
  args: DeliverContinueArgs,
  state: PipelineState,
  result: StageResult,
): Promise<void> {
  switch (result.type) {
    case "advance":
      await tx.exec(
        "UPDATE driver_state SET pending_user_answer = NULL, step_index = step_index + 1 WHERE id = 1",
      );
      return;
    case "walk_back_to": {
      const flow = args.registry?.flows.get(state.driver.flow_name);
      const target = flow ? flow.indexOf(result.step) : -1;
      if (target < 0) {
        throw new KernelError({
          code: "WALK_BACK_TARGET_NOT_FOUND",
          message: `gate on_resume walk_back target '${result.step}' is not in flow '${state.driver.flow_name}'`,
          detail: { target: result.step, reason: result.reason },
        });
      }
      await tx.exec(
        "UPDATE driver_state SET pending_user_answer = NULL, step_index = ? WHERE id = 1",
        [target],
      );
      return;
    }
    case "complete":
      // Sweep phases + write the verdict atomically (INV_007). The human
      // abandon path lands here with verdict='rejected' — never reaching
      // finalize, so finalize's `?? "accepted"` default cannot mislabel it.
      await completeTask(
        tx,
        state.phases,
        result.directive.verdict,
        tx.now,
        "swept on gate completion",
      );
      await tx.exec("UPDATE driver_state SET pending_user_answer = NULL WHERE id = 1");
      return;
    default:
      throw new KernelError({
        code: "UNSUPPORTED_GATE_RESUME_RESULT",
        message: `gate on_resume returned unsupported result '${result.type}' on the human-answer path`,
        detail: { result_type: result.type },
      });
  }
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

// Union the host-reported file accounting into pipeline_state. The reviewer
// fanout shapes itself (which reviewers run, the diff snapshot, the
// sacred-tests check) off this surface; an empty list silently voids those
// guarantees, so a host that knows what changed delivers it here. Union
// (set-merge) keeps the call idempotent across a retried delivery.
async function mergeDeliveredFiles(
  tx: Transaction,
  modified: string[] | undefined,
  created: string[] | undefined,
): Promise<void> {
  await mergeFileColumn(tx, "files_modified", modified);
  await mergeFileColumn(tx, "files_created", created);
}

async function mergeFileColumn(
  tx: Transaction,
  column: "files_modified" | "files_created",
  add: string[] | undefined,
): Promise<void> {
  if (add === undefined || add.length === 0) return;
  const clean = add.filter((p) => typeof p === "string" && p.length > 0);
  if (clean.length === 0) return;
  const row = await tx.queryRow<Record<string, string | null>>(
    `SELECT ${column} FROM pipeline_state WHERE id = 1`,
  );
  let current: string[] = [];
  const raw = row?.[column];
  if (raw !== null && raw !== undefined && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        current = parsed.filter((v): v is string => typeof v === "string");
      }
    } catch {
      current = [];
    }
  }
  const merged = [...new Set([...current, ...clean])];
  await tx.exec(
    `UPDATE pipeline_state SET ${column} = ? WHERE id = 1`,
    [JSON.stringify(merged)],
  );
}
