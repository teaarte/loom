// The transport-neutral orchestration compositions — the conformant
// bodies that wrap the kernel's delivery / create / recover lib functions
// in the bookkeeping every transport MUST perform identically:
//
//   * a single `withStateTransaction` over the kernel mutation,
//   * a co-committed audit row,
//   * the op-keyed idempotency-ledger row, materialized with the shaped
//     wire envelope so a duplicate delivery replays verbatim,
//   * the resume-point `step_index` persist,
//   * the honest server-side file delta folded into the carrier.
//
// Implementing this ONCE here is what keeps a thin transport from silently
// dropping a contract obligation (the file-delta gap that turned the
// change-conditional reviewers into no-ops). The stdio tools and the
// headless loop both call these; the tools keep only their transport
// shells (allowlist, flag parse, ledger replay-read, refusals, error
// shaping) around them.
//
// Ambient clock: these run OUTSIDE the kernel, so `captureNow()` mints the
// per-call NowToken the kernel threads through each tx — the same mint
// point the stdio tools use.

import {
  buildRetryFailedDirective,
  captureNow,
  deliverContinue,
  initializeTask,
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
  type ContinueTaskInput,
  type GateRole,
  type PipelineState,
  type PolicyName,
  type RecoveryChoice,
  type Registry,
} from "@loomfsm/kernel";
import type { TransportResponse } from "@loomfsm/transport-types";

import { shape } from "./adapter.js";
import { readTaskId, writeAuditRow } from "./audit.js";
import { persistDeltaBaseline, readDeltaBaseline } from "./delta-baseline.js";
import { gitBaselineRef, gitDelta } from "./git-delta.js";
import { persistDriverStepIndex } from "./progress.js";

// ----- create ------------------------------------------------------------

export interface CreateAndStartArgs {
  registry: Registry;
  task: string;
  client_idempotency_uuid: string;
  owner_id?: string;
  policy_preset?: string;
  gate_policies?: Partial<Record<GateRole, PolicyName>>;
  complexity_hint?: "simple" | "medium" | "complex";
  // Generic opening-decisions seed passed straight to the kernel; the
  // driver names none of its keys.
  initial_decisions?: Record<string, unknown>;
  // Forensic-only caller identity; the kernel never branches on it.
  identifier?: string;
}

export interface CreateAndStartResult {
  response: TransportResponse;
  task_id: string;
  driver_state_id: string;
  state: PipelineState;
}

// Create a task and run the FSM to its first directive — run-task's body
// minus the transport shell (allowlist / uuid-required / replay-read /
// auto-rotate / flag parse, which stay in the calling tool). Mirrors the
// stdio create path step-for-step so both produce an identical first
// envelope + cached creation ledger row.
export async function createAndStart(
  projectDir: string,
  args: CreateAndStartArgs,
): Promise<CreateAndStartResult> {
  // Capture the file-delta baseline (the working tree's ref at task start)
  // BEFORE the create tx — git I/O must not run under a held write lock.
  // null when the project is not a git work tree; then no server-side delta
  // is computed later and any host accounting stands.
  const baselineRef = gitBaselineRef(projectDir);
  const identifier = args.identifier ?? "unknown";

  const ids = await withStateTransaction(projectDir, captureNow(), async (tx) => {
    const created = await initializeTask(tx, {
      project_dir: projectDir,
      task: args.task,
      task_short: null,
      owner_id: args.owner_id ?? "anonymous",
      ...(args.policy_preset !== undefined ? { policy_preset: args.policy_preset } : {}),
      ...(args.gate_policies !== undefined ? { gate_policies: args.gate_policies } : {}),
      ...(args.complexity_hint !== undefined ? { complexity_hint: args.complexity_hint } : {}),
      ...(args.initial_decisions !== undefined ? { initial_decisions: args.initial_decisions } : {}),
      client_idempotency_uuid: args.client_idempotency_uuid,
      phases: args.registry.bundle.phases,
      flow_name: args.registry.bundle.default_flow,
    });
    await writeAuditRow(tx, {
      type: "pipeline_run_task",
      taskId: created.task_id,
      driverStateId: created.driver_state_id,
      payload: { client_identifier_unverified: identifier },
    });
    // Co-commit the delta baseline with the task record so a resumed task
    // measures changes from the same starting ref.
    if (baselineRef !== null) {
      await persistDeltaBaseline(tx, baselineRef);
    }
    return created;
  });

  const loaded = await readState(projectDir);
  const { state: ticked, directive } = await runFSM(loaded, args.registry);
  const response = shape(directive, { driver_state_id: ids.driver_state_id });

  await withStateTransaction(projectDir, captureNow(), async (tx) => {
    await persistDriverStepIndex(tx, ticked.driver.step_index);
    await writeLedgerRow(tx, `task-create:${args.client_idempotency_uuid}`, {
      driver_state_id: ids.driver_state_id,
      task_id: ids.task_id,
      response_blob: JSON.stringify(response),
    });
  });

  return {
    response,
    task_id: ids.task_id,
    driver_state_id: ids.driver_state_id,
    state: ticked,
  };
}

// ----- deliver -----------------------------------------------------------

export interface DeliverAndAdvanceArgs {
  registry: Registry;
  // Already variant-validated by the caller (no `recovery`, no partial
  // fanout) — those are refused at the transport shell.
  input: ContinueTaskInput;
  driver_state_id: string;
  identifier?: string;
}

export interface DeliverAndAdvanceResult {
  response: TransportResponse;
  state: PipelineState;
}

// Deliver a result / fanout batch / user-answer and run the FSM to the next
// directive — continue-task's body minus the transport shell. The server
// git-delta is folded in here so EVERY transport reports the honest surface
// without re-deriving the plumbing.
export async function deliverAndAdvance(
  projectDir: string,
  args: DeliverAndAdvanceArgs,
): Promise<DeliverAndAdvanceResult> {
  const { registry, driver_state_id } = args;
  const identifier = args.identifier ?? "unknown";
  const keys = ledgerKeysFor(args.input);

  // Replay guard — a materialized ledger blob under any op key means this
  // exact delivery already committed; return the cached next-step envelope
  // WITHOUT re-ticking. This is what keeps a duplicate delivery (a crash
  // between commit and record, a re-resumed lost turn) from re-entering the
  // already-advanced FSM and tripping the spawn duplicate-window guard. The
  // shared composition owns the dedup so EVERY caller — the stdio tool, the
  // headless loop — is safe, not just the ones that remember to check.
  const cached = await readCachedDelivery(projectDir, keys);
  if (cached !== null) {
    return { response: cached, state: await readState(projectDir) };
  }

  // Compute the honest file delta server-side and fold it into the carrier
  // (set-unioned by the kernel, so this is idempotent and a host that
  // reports nothing is fully covered). Git I/O runs OUTSIDE the delivery tx.
  const deliveredInput = await withServerComputedDelta(projectDir, args.input);

  await withStateTransaction(projectDir, captureNow(), async (tx) => {
    await deliverContinue(tx, {
      input: deliveredInput,
      driver_state_id,
      resolveOutputKind: (agent) => registry.agents.get(agent)?.output_kind,
      vocabularies: registry.vocabularies,
      registry,
    });
    const taskId = await readTaskId(tx);
    await writeAuditRow(tx, {
      type: "pipeline_continue_task",
      taskId,
      driverStateId: driver_state_id,
      payload: { client_identifier_unverified: identifier },
    });
  });

  const loaded = await readState(projectDir);
  const { state: ticked, directive } = await runFSM(loaded, registry);
  const response = shape(directive, { driver_state_id });

  const taskId = loaded.task_id;
  await withStateTransaction(projectDir, captureNow(), async (tx) => {
    await persistDriverStepIndex(tx, ticked.driver.step_index);
    for (const key of keys) {
      await writeLedgerRow(tx, key, {
        driver_state_id,
        task_id: taskId,
        response_blob: JSON.stringify(response),
      });
    }
  });

  return { response, state: ticked };
}

// ----- recover -----------------------------------------------------------

export interface RecoverAndAdvanceArgs {
  registry: Registry;
  driver_state_id: string;
  choice: RecoveryChoice;
  agent_run_ids?: string[];
  // Server-issued: omit on the first call (minted + echoed back), pass back
  // to replay. The headless caller threads one per logical recovery action.
  recovery_id?: string;
  identifier?: string;
}

export interface RecoverAndAdvanceResult {
  response: TransportResponse;
  recovery_id: string;
}

// Apply a recovery choice and resolve the next directive — recover's body
// minus the owner-check / cross-owner-marker shell (those are stdio
// transport policy; the headless single-operator path needs neither). A
// re-entrant choice ticks the FSM; a terminal choice shapes directly.
export async function recoverAndAdvance(
  projectDir: string,
  args: RecoverAndAdvanceArgs,
): Promise<RecoverAndAdvanceResult> {
  const { registry, driver_state_id } = args;
  const recoveryId =
    args.recovery_id !== undefined && args.recovery_id.length > 0
      ? args.recovery_id
      : makeRecoveryId();
  const identifier = args.identifier ?? "unknown";
  const ledgerKey = `recovery:${driver_state_id}:${args.choice}:${recoveryId}`;

  const result = await withStateTransaction(projectDir, captureNow(), async (tx) => {
    const recovered = await recoverTask(tx, {
      driver_state_id,
      choice: args.choice,
      ...(args.agent_run_ids !== undefined ? { agent_run_ids: args.agent_run_ids } : {}),
      recovery_id: recoveryId,
    });
    const taskId = await readTaskId(tx);
    await writeAuditRow(tx, {
      type: "pipeline_recover",
      taskId,
      driverStateId: driver_state_id,
      payload: { client_identifier_unverified: identifier, choice: args.choice, recovery_id: recoveryId },
      errorClass: outcomeErrorClass(recovered.outcome),
    });
    return recovered;
  });

  let response: TransportResponse;
  if (result.reenter) {
    const loaded = await readState(projectDir);
    if (args.choice === "retry-failed") {
      const directive = buildRetryFailedDirective(loaded, registry, args.agent_run_ids ?? []);
      response = shape(directive, { driver_state_id });
    } else {
      const { directive } = await runFSM(loaded, registry);
      response = shape(directive, { driver_state_id });
    }
  } else {
    response = await terminalRecoveryResponse(projectDir, args.choice);
  }

  await withStateTransaction(projectDir, captureNow(), async (tx) => {
    const taskId = await readTaskId(tx);
    await writeLedgerRow(tx, ledgerKey, {
      driver_state_id,
      task_id: taskId,
      response_blob: JSON.stringify(response),
    });
  });

  return { response, recovery_id: recoveryId };
}

// ----- shared internals --------------------------------------------------

// The op-shaped idempotency-ledger keys for a delivery. The fanout batch
// shares ONE materialized envelope across all its agent_run_ids. Exported
// so a transport shell reads the same keys for its replay lookup.
export function ledgerKeysFor(input: ContinueTaskInput): string[] {
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

// The materialized next-step envelope cached under any of a delivery's op
// keys (the fanout batch shares one across all its agent_run_ids). Returns
// null when none is present — i.e. this is a first, real delivery.
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

// Fold the server-computed git delta into an agent-result's file carrier.
// Returns the input unchanged for every other variant (and when the project
// is not a git work tree / has no stored baseline).
async function withServerComputedDelta(
  projectDir: string,
  input: ContinueTaskInput,
): Promise<ContinueTaskInput> {
  if (input.type !== "agent-result") return input;
  const baseline = await readDeltaBaseline(projectDir);
  const delta = gitDelta(projectDir, baseline);
  if (delta === null) return input;
  return {
    ...input,
    files_modified: [...(input.files_modified ?? []), ...delta.modified],
    files_created: [...(input.files_created ?? []), ...delta.created],
  };
}

async function terminalRecoveryResponse(
  projectDir: string,
  choice: RecoveryChoice,
): Promise<TransportResponse> {
  const taskId = await withReadTaskId(projectDir);
  if (choice === "force-close") {
    return {
      status: "complete",
      task_id: taskId,
      verdict: "failed_force_closed",
      summary: "task force-closed via recovery",
    };
  }
  // abandon — the canonical pipeline verdict is NULL (status='abandoned').
  // The wire `complete` form has no abandoned/null verdict, so it maps to
  // 'rejected' (the abandon-intent terminal); the stored verdict stays NULL.
  return {
    status: "complete",
    task_id: taskId,
    verdict: "rejected",
    summary: "task abandoned via recovery",
  };
}

// The forensic recovery outcome maps to the audit error_class: an
// idempotent / raced recovery is a successful no-op tagged for forensics,
// not a failure — verdict stays 'ok' and the tag rides on error_class.
function outcomeErrorClass(outcome: "applied" | "idempotent" | "raced"): string | null {
  switch (outcome) {
    case "idempotent":
      return "recovery-idempotent";
    case "raced":
      return "recovery-raced";
    case "applied":
      return null;
  }
}

// Read the canonical state through a read-only TransactionImpl — the caller
// never commits this scope, so the now token threaded here is local and not
// observable on disk.
export async function readState(projectDir: string): Promise<PipelineState> {
  const db = openDb(projectDir);
  const tx = new TransactionImpl(db, captureNow());
  return await loadState(tx);
}

async function withReadTaskId(projectDir: string): Promise<string | null> {
  const db = openDb(projectDir);
  const tx = new TransactionImpl(db, captureNow());
  return await readTaskId(tx);
}

// Re-exported so the type is reachable without naming the kernel barrel.
export { KernelError };
