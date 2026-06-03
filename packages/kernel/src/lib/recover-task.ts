// Recovery dispatcher — the variant router behind the recovery MCP tool.
//
// Mirrors `deliverContinue`: a switch over `choice`, each branch performing
// its in-tx mutations alongside a co-committed
// `recovery:<driver_state_id>:<choice>:<recovery_id>` idempotency-ledger
// row (written with `response_blob = null`; the caller materializes the
// shaped wire envelope after the post-recovery FSM tick resolves). A
// replay (ledger row already present for the same recovery_id) re-mutates
// nothing — it returns the same `reenter` verdict so the caller can
// re-shape the response deterministically without double-applying the
// recovery.
//
// The five choices map to exactly the documented mutations:
//   abandon       — drain pending agents + the pending user answer, set
//                   status='abandoned', verdict=NULL, ended_at. No
//                   pipeline_violation. Idempotent against a terminal task.
//   force-close   — drop pending agents + pending user answer, close every
//                   non-terminal phase as skipped (so a non-null verdict
//                   leaves no open phase — INV_007 holds), set
//                   status='completed', verdict='failed_force_closed',
//                   pipeline_violation='force-close', ended_at.
//   retry         — re-enter the FSM at the current step. Valid only when
//                   no pending agents AND no pending user answer.
//   retry-failed  — re-spawn the named pending subset (good siblings stay
//                   intact). The still-pending rows are re-shuttled when
//                   the FSM re-enters; no provider-capability consultation
//                   happens here.
//   cancel-pending — drain pending agents + pending user answer, advance
//                   past the failing stage, pipeline_violation='pending-cancel'.
//
// `reenter` tells the caller whether to run the FSM after commit (retry /
// retry-failed / cancel-pending) or shape a terminal response directly
// (abandon / force-close).
//
// Wall-clock discipline: every timestamp comes from `tx.now`; the
// recovery id is minted through `ids.ts` (the documented mint-time
// exception) by the caller and threaded in here.

import { resolveSpawnModel } from "../provider-router.js";
import { KernelError } from "../state/db.js";
import type { RecoveryChoice } from "../types/continue-task.js";
import type { ProviderShuttleIntent } from "../types/provider.js";
import type { Registry } from "../types/registry.js";
import type { PipelineState } from "../types/state.js";
import type { Transaction } from "../types/transaction.js";
import type { KernelDirective } from "../types/transport.js";

import { readLedgerRow, writeLedgerRow } from "./ledger.js";

export interface RecoverTaskArgs {
  driver_state_id: string;
  choice: RecoveryChoice;
  // Required for retry-failed; ignored by the other choices.
  agent_run_ids?: string[];
  // Server-issued, resolved by the caller before the tx (minted on the
  // first call, echoed back on a retry). Keys the idempotency ledger.
  recovery_id: string;
}

// Forensic discriminator the caller maps to the audit `error_class`:
//   applied     — the recovery mutated state (or is a re-entrant action).
//   idempotent  — abandon / force-close of an already-terminal task; no
//                 state change. error_class "recovery-idempotent".
//   raced       — a serialized recovery that found the work already done
//                 (cancel-pending with nothing to drain). error_class
//                 "recovery-raced".
export type RecoveryOutcome = "applied" | "idempotent" | "raced";

export interface RecoverTaskResult {
  recovery_id: string;
  // Whether the caller must run the FSM after commit (re-entrant choices)
  // or shape a terminal response directly (abandon / force-close).
  reenter: boolean;
  // Forensic classification of this recovery for the audit row.
  outcome: RecoveryOutcome;
}

const REENTRANT: ReadonlySet<RecoveryChoice> = new Set<RecoveryChoice>([
  "retry",
  "retry-failed",
  "cancel-pending",
]);

export async function recoverTask(
  tx: Transaction,
  args: RecoverTaskArgs,
): Promise<RecoverTaskResult> {
  const key = `recovery:${args.driver_state_id}:${args.choice}:${args.recovery_id}`;

  // Replay guard — a ledger row already present for this exact recovery
  // action means the mutation committed on an earlier call. Re-mutating
  // would double-apply (a second step advance, a second drain); skip
  // straight to the re-entry verdict so the caller re-shapes the same
  // response without touching state.
  const existing = await readLedgerRow(tx, key);
  if (existing !== null) {
    // The mutation committed on an earlier call; its audit row already
    // carries the real classification. The replay re-mutates nothing, so
    // there is no fresh outcome to tag.
    return {
      recovery_id: args.recovery_id,
      reenter: REENTRANT.has(args.choice),
      outcome: "applied",
    };
  }

  const status = await readStatus(tx);
  const reentrant = REENTRANT.has(args.choice);

  // A re-entrant choice against a task that has already terminated cannot
  // resume — the path forward is abandon or a fresh task.
  if (reentrant && status !== "in_progress") {
    throw new KernelError({
      code: "RECOVERY_TERMINAL",
      message: `cannot ${args.choice} a task with status '${status}'`,
      detail: { choice: args.choice, status },
    });
  }

  let outcome: RecoveryOutcome;
  switch (args.choice) {
    case "abandon":
      outcome = await applyAbandon(tx, status);
      break;
    case "force-close":
      outcome = await applyForceClose(tx, status);
      break;
    case "retry":
      await applyRetry(tx);
      outcome = "applied";
      break;
    case "retry-failed":
      await applyRetryFailed(tx, args.agent_run_ids ?? []);
      outcome = "applied";
      break;
    case "cancel-pending":
      outcome = await applyCancelPending(tx);
      break;
    default: {
      const _exhaustive: never = args.choice;
      return _exhaustive;
    }
  }

  const taskId = await readTaskId(tx);
  await writeLedgerRow(tx, key, {
    driver_state_id: args.driver_state_id,
    task_id: taskId,
    response_blob: null,
  });

  return { recovery_id: args.recovery_id, reenter: reentrant, outcome };
}

// retry-failed re-shuttle. The named pending rows are re-launched
// reusing their EXISTING agent_run_id — built into a shuttle intent
// WITHOUT a fresh `begin_spawn`, so the spawn duplicate-window guard is
// never consulted. Re-issuing the same agent_run_id to an idempotent
// provider dedups at the provider's own window, so this is the safe
// re-launch path. The still-pending rows stay in place; the host re-runs
// the named agents and delivers their results through the normal path.
//
// Refuses with PROVIDER_NOT_IDEMPOTENT when any named agent resolves to
// a provider that does NOT declare `capabilities.idempotent_spawn`:
// re-issuing the same agent_run_id to a non-idempotent vendor could
// double-execute, so the caller must `cancel-pending` first to surface a
// fresh agent_run_id.
//
// `skip_idempotency_check` lifts that gate for the ONE caller that can prove
// re-execution is safe regardless of the provider's declared idempotency: the
// resume restart-head re-shuttling its OWN pending rows (same agent_run_id,
// delivery de-duped by the ledger) under an executor that asserts idempotent
// re-execution (a sandboxed worktree run just redoes the work). The explicit
// retry-failed recovery never sets it — there the provider gate stands.
//
// Runs on the loaded post-recovery state (the recovery committed,
// leaving the rows in place); no tx, no clock — a pure mapping from
// pending rows + registry to a `KernelDirective`.
export function buildRetryFailedDirective(
  state: PipelineState,
  registry: Registry,
  agentRunIds: string[],
  opts: { skip_idempotency_check?: boolean } = {},
): KernelDirective {
  const byId = new Map(state.pending_agents.map((r) => [r.agent_run_id, r]));
  const intents: ProviderShuttleIntent[] = [];
  for (const arid of agentRunIds) {
    const row = byId.get(arid);
    if (row === undefined) {
      // Validated present inside the recovery tx; a miss here means a
      // racing drain landed between commit and re-shuttle.
      throw new KernelError({
        code: "RECOVERY_STALE",
        message: `agent_run_id '${arid}' is no longer pending`,
        detail: { agent_run_id: arid },
      });
    }
    const provider = registry.providers.resolve(row.agent, state, row.phase);
    if (opts.skip_idempotency_check !== true && !provider.capabilities.idempotent_spawn) {
      throw new KernelError({
        code: "PROVIDER_NOT_IDEMPOTENT",
        message:
          `retry-failed cannot re-shuttle agent '${row.agent}' under non-idempotent ` +
          `provider '${provider.name}' — cancel-pending first to surface a fresh agent_run_id`,
        detail: { agent: row.agent, provider: provider.name, agent_run_id: arid },
      });
    }
    const agentDef = registry.agents.get(row.agent);
    const intent: ProviderShuttleIntent = {
      agent: row.agent,
      agent_run_id: row.agent_run_id,
      phase: row.phase,
      model: row.model ?? resolveSpawnModel(registry, row.agent, row.phase, state),
      prompt: reShuttlePromptStub(state.task_id, row.agent, row.phase, agentDef?.template_path ?? ""),
      extras: { provider: provider.name },
    };
    if (agentDef?.system_prompt !== undefined) {
      intent.system_prompt = agentDef.system_prompt;
    }
    if (agentDef?.mcp_tools !== undefined) {
      intent.mcp_tools_available = agentDef.mcp_tools;
    }
    intents.push(intent);
  }
  const only = intents[0];
  if (intents.length === 1 && only !== undefined) {
    return { kind: "shuttle", spawn: only };
  }
  return { kind: "shuttle-batch", spawns: intents };
}

// Deterministic prompt stub mirroring the SpawnStage interpreter's stub.
// Real prompt rendering is a bundle concern (a before-spawn event Step),
// out of the kernel's re-shuttle path.
function reShuttlePromptStub(
  taskId: string | null,
  agent: string,
  phase: string,
  templatePath: string,
): string {
  return [
    `agent=${agent}`,
    `phase=${phase}`,
    `task_id=${taskId ?? ""}`,
    `template=${templatePath}`,
  ].join("\n");
}

// abandon — clean teardown. Idempotent against a terminal task: a second
// abandon (or an abandon of an already-closed task) rewrites nothing, so
// ended_at stays pinned to the original close — tagged `idempotent`.
async function applyAbandon(tx: Transaction, status: string): Promise<RecoveryOutcome> {
  if (status !== "in_progress") return "idempotent";
  await drainPending(tx);
  await tx.exec(
    "UPDATE pipeline_state SET status = 'abandoned', verdict = NULL, ended_at = ? WHERE id = 1",
    [tx.now],
  );
  return "applied";
}

// force-close — terminate under operator override. Closing every open
// phase as skipped is what keeps INV_007 (non-null verdict → all phases
// terminal) satisfied; dropping pending rows keeps INV_012 clean. A
// force-close of an already-terminal task rewrites nothing — `idempotent`.
async function applyForceClose(tx: Transaction, status: string): Promise<RecoveryOutcome> {
  if (status !== "in_progress") return "idempotent";
  await drainPending(tx);
  await tx.exec(
    "UPDATE phases SET status = 'skipped', skipped_reason = 'force-closed', updated_at = ? " +
      "WHERE status NOT IN ('completed', 'skipped')",
    [tx.now],
  );
  await tx.exec(
    "UPDATE pipeline_state SET status = 'completed', verdict = 'failed_force_closed', " +
      "pipeline_violation = 'force-close', ended_at = ? WHERE id = 1",
    [tx.now],
  );
  return "applied";
}

// retry — re-enter the FSM at the current step. Valid only when nothing
// is outstanding; an outstanding pending agent or user answer means the
// caller wants retry-failed / cancel-pending instead.
async function applyRetry(tx: Transaction): Promise<void> {
  const pending = await countPending(tx);
  const pendingAnswer = await hasPendingUserAnswer(tx);
  if (pending > 0 || pendingAnswer) {
    throw new KernelError({
      code: "RECOVERY_INVALID",
      message: "retry is valid only when no pending agents and no pending user answer remain",
      detail: { pending_agents: pending, pending_user_answer: pendingAnswer },
    });
  }
  // No state mutation — the ledger row alone records the action; the FSM
  // re-runs at the current step_index on re-entry.
}

// retry-failed — re-spawn the named pending subset. The good siblings
// from the same batch stay intact; the still-pending named rows are
// re-shuttled when the FSM re-enters. No mutation beyond validation.
async function applyRetryFailed(
  tx: Transaction,
  agentRunIds: string[],
): Promise<void> {
  if (agentRunIds.length === 0) {
    throw new KernelError({
      code: "RECOVERY_INVALID",
      message: "retry-failed requires a non-empty agent_run_ids list",
    });
  }
  const present = new Set<string>();
  for (const row of await tx.queryAll<{ agent_run_id: unknown }>(
    "SELECT agent_run_id FROM pending_agents",
  )) {
    present.add(String(row.agent_run_id));
  }
  const unknown = agentRunIds.filter((id) => !present.has(id));
  if (unknown.length > 0) {
    throw new KernelError({
      code: "RECOVERY_STALE",
      message: "one or more agent_run_ids are no longer pending (already drained)",
      detail: { unknown_agent_run_ids: unknown },
    });
  }
  // The named rows are still pending; re-entry re-shuttles them.
}

// cancel-pending — drain everything outstanding and step past the failing
// stage so the FSM resumes at the next step on re-entry. When nothing is
// outstanding (a racing delivery already drained the rows) the drain is a
// no-op — the state mutation is unchanged (the step still advances and the
// violation is recorded), only the forensic tag flips to `raced`.
async function applyCancelPending(tx: Transaction): Promise<RecoveryOutcome> {
  const raced = (await countPending(tx)) === 0 && !(await hasPendingUserAnswer(tx));
  await drainPending(tx);
  await tx.exec(
    "UPDATE pipeline_state SET pipeline_violation = 'pending-cancel' WHERE id = 1",
  );
  await tx.exec(
    "UPDATE driver_state SET step_index = step_index + 1 WHERE id = 1",
  );
  return raced ? "raced" : "applied";
}

// Drain pending agents and clear the pending user answer — shared by the
// abandon / force-close / cancel-pending paths.
async function drainPending(tx: Transaction): Promise<void> {
  await tx.exec("DELETE FROM pending_agents");
  await tx.exec("UPDATE driver_state SET pending_user_answer = NULL WHERE id = 1");
}

async function readStatus(tx: Transaction): Promise<string> {
  const row = await tx.queryRow<{ status: unknown }>(
    "SELECT status FROM pipeline_state WHERE id = 1",
  );
  if (row === null) {
    throw new KernelError({
      code: "STATE_NOT_INITIALIZED",
      message: "pipeline_state row missing — no task to recover",
    });
  }
  return String(row.status);
}

async function countPending(tx: Transaction): Promise<number> {
  const row = await tx.queryRow<{ c: unknown }>(
    "SELECT COUNT(*) AS c FROM pending_agents",
  );
  return row === null ? 0 : Number(row.c);
}

async function hasPendingUserAnswer(tx: Transaction): Promise<boolean> {
  const row = await tx.queryRow<{ pending_user_answer: unknown }>(
    "SELECT pending_user_answer FROM driver_state WHERE id = 1",
  );
  if (row === null || row.pending_user_answer === null) return false;
  return String(row.pending_user_answer).length > 0;
}

async function readTaskId(tx: Transaction): Promise<string | null> {
  const row = await tx.queryRow<{ task_id: unknown }>(
    "SELECT task_id FROM pipeline_state WHERE id = 1",
  );
  if (row === null || row.task_id === null) return null;
  return String(row.task_id);
}
