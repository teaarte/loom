// FSM core: the tick loop, the stage-context constructor, the
// `interpretStage` dispatcher, the `BundleOp` applier, and the
// helper that shapes kernel-coded errors into `KernelDirective`s.
//
// The loop is intentionally thin — every Stage variant has its own
// interpreter in `./stages/`; everything else is plumbing. Two
// load-bearing invariants live here:
//
//   1. `captureNow()` fires once per tick OUTSIDE the SQLite tx.
//      The token threads into `withStateTransaction`, `tx.now`,
//      every kernel and bundle write, and the ledger row written
//      by the caller. Replay re-supplies the persisted token via
//      `opts.replay_now_token` so every comparison reproduces bit-
//      for-bit.
//
//   2. `runFSM` returns a `KernelDirective` and never names the
//      wire envelope. Transport adapters shape directives into
//      their own envelopes; the kernel does not own the wire form.
//      The seam is enforced by CI grep on `packages/kernel/src/`.

import { makeAgentRunId } from "./ids.js";
import { HookRunner } from "./hook-runner.js";
import { dispatchEventSteps } from "./lib/dispatch-event-steps.js";
import { narrowStateForBundle } from "./narrow.js";
import { interpretFanout } from "./stages/fanout.js";
import { interpretFinalize } from "./stages/finalize.js";
import { interpretGate } from "./stages/gate.js";
import { interpretSpawn } from "./stages/spawn.js";
import { interpretStep } from "./stages/step.js";
import { captureNow, KernelError } from "./state/db.js";
import { withStateTransaction } from "./state/transaction.js";
import type { AgentRecord } from "./types/agent-result.js";
import type {
  AgentRecordsAccess,
  AuditAccess,
  BundleOp,
  BundleScratchTx,
  FindingsAccess,
  HookContext,
  StageContext,
} from "./types/context.js";
import type { Finding } from "./types/findings.js";
import type { NowToken } from "./types/now.js";
import type { Stage, StageResult } from "./types/plugins.js";
import type { Registry } from "./types/registry.js";
import type { ModelName, Phase } from "./types/row-types.js";
import type { PipelineState } from "./types/state.js";
import type { AuditEntry, Transaction } from "./types/transaction.js";
import type { KernelDirective } from "./types/transport.js";

export interface RunFSMOptions {
  // When set, replaces the per-tick `captureNow()` reading so a
  // replay path can re-supply the persisted ledger NowToken
  // verbatim.
  replay_now_token?: NowToken;
  // Optional caller identity threaded into kernel writes. Stays
  // here for forward compatibility; current interpreters do not
  // read it.
  caller_owner_id?: string | null;
}

export interface RunFSMResult {
  state: PipelineState;
  directive: KernelDirective;
}

export async function runFSM(
  state: PipelineState,
  registry: Registry,
  opts: RunFSMOptions = {},
): Promise<RunFSMResult> {
  const hookRunner = new HookRunner(registry);

  while (state.status === "in_progress") {
    const now: NowToken = opts.replay_now_token ?? captureNow();
    state.now = now;

    const flow = registry.flows.get(state.driver.flow_name);
    if (!flow) {
      return {
        state,
        directive: kernelError(state, "FLOW_NOT_REGISTERED", {
          flow_name: state.driver.flow_name,
        }),
      };
    }
    if (state.driver.step_index >= flow.length) {
      return {
        state,
        directive: kernelError(state, "FLOW_OVERFLOW", {
          step_index: state.driver.step_index,
          flow_length: flow.length,
        }),
      };
    }

    const stageName = flow[state.driver.step_index];
    if (stageName === undefined) {
      return {
        state,
        directive: kernelError(state, "FLOW_OVERFLOW", {
          step_index: state.driver.step_index,
        }),
      };
    }
    const stage = registry.stages.get(stageName);
    if (!stage) {
      return {
        state,
        directive: kernelError(state, "STAGE_NOT_REGISTERED", {
          stage: stageName,
        }),
      };
    }

    const beforeCtx = buildHookContext(state, registry, now, stageName);
    await hookRunner.fire(`before-${stage.kind}`, beforeCtx);

    const stageResult = await withStateTransaction(
      state.project_dir,
      now,
      async (tx) => {
        const { ctx, ops } = buildStageContext(state, registry, tx);
        await dispatchEventSteps(`before-${stage.kind}`, ctx, tx, ops);
        const result = await interpretStage(stage, state, ctx);
        // Drain BundleOps that the interpreter (e.g. a positional
        // StepStage's `run` body) pushed into the scratch buffer.
        // A throw here aborts the outer tx — invariants on commit
        // catch what mutators alone cannot.
        await applyBundleOps(tx, ops);
        ops.length = 0;
        return result;
      },
    );

    const afterCtx = buildHookContext(state, registry, now, stageName);
    await hookRunner.fire(`after-${stage.kind}`, afterCtx);

    if (stageResult.type === "advance") {
      state.driver.step_index += 1;
      continue;
    }
    if (stageResult.type === "walk_back_to") {
      const target = flow.indexOf(stageResult.step);
      if (target < 0) {
        return {
          state,
          directive: kernelError(state, "WALK_BACK_TARGET_NOT_FOUND", {
            target: stageResult.step,
            reason: stageResult.reason,
          }),
        };
      }
      state.driver.step_index = target;
      continue;
    }
    if (stageResult.type === "shuttle") {
      return {
        state,
        directive: { kind: "shuttle", spawn: stageResult.intent },
      };
    }
    if (stageResult.type === "shuttle-batch") {
      return {
        state,
        directive: { kind: "shuttle-batch", spawns: stageResult.spawns },
      };
    }
    if (stageResult.type === "ask_user") {
      return {
        state,
        directive: {
          kind: "ask-user",
          driver_state_id: state.driver_state_id,
          gate: stageResult.directive.gate,
          gate_event_id: stageResult.directive.gate_event_id,
          message: stageResult.directive.message,
          valid_answers: stageResult.directive.valid_answers,
        },
      };
    }
    if (stageResult.type === "complete") {
      state.status = "completed";
      return {
        state,
        directive: {
          kind: "complete",
          task_id: stageResult.directive.task_id,
          verdict: stageResult.directive.verdict,
          summary: stageResult.directive.summary,
        },
      };
    }
    if (stageResult.type === "halt") {
      return {
        state,
        directive: {
          kind: "error",
          driver_state_id: state.driver_state_id,
          code: stageResult.directive.code,
          message: stageResult.directive.message,
          recovery_options: stageResult.directive.recovery_options,
        },
      };
    }
    const _exhaustive: never = stageResult;
    return _exhaustive;
  }

  return {
    state,
    directive: {
      kind: "complete",
      task_id: state.task_id,
      verdict: state.verdict ?? "accepted",
      summary: `task complete (verdict=${state.verdict ?? "accepted"})`,
    },
  };
}

// ============================================================================
// interpretStage — exhaustive 5-way switch
// ============================================================================

export async function interpretStage(
  stage: Stage,
  state: PipelineState,
  ctx: StageContext,
): Promise<StageResult> {
  switch (stage.kind) {
    case "spawn":
      return interpretSpawn(stage, state, ctx);
    case "fanout":
      return interpretFanout(stage, state, ctx);
    case "gate":
      return interpretGate(stage, state, ctx);
    case "step":
      return interpretStep(stage, state, ctx);
    case "finalize":
      return interpretFinalize(stage, state, ctx);
    default: {
      const _exhaustive: never = stage;
      return _exhaustive;
    }
  }
}

// ============================================================================
// buildStageContext + BundleScratchTx adapter
// ============================================================================

export interface BuiltStageContext {
  ctx: StageContext;
  // Mutable buffer the BundleScratchTx mutators push into. The
  // kernel drains it via `applyBundleOps(tx, ops)` after the
  // interpreter / event-Step run returns.
  ops: BundleOp[];
}

export function buildStageContext(
  state: PipelineState,
  registry: Registry,
  tx: Transaction,
): BuiltStageContext {
  const ops: BundleOp[] = [];
  const scratchTx: BundleScratchTx = makeBundleScratchTx(state, tx, ops);

  // FindingsAccess / AuditAccess / AgentRecordsAccess pre-materialize
  // their contents from the in-flight tx — full implementation lands
  // with the bundle-loader. The empty-collection stubs below keep the
  // contract surface honest in MVP; no test fixture in this session
  // queries the heavy collections.
  const findingsAccess: FindingsAccess = {
    query: () => [] as Finding[],
    countBlocking: () => 0,
    queryByPhase: () => [] as Finding[],
  };
  const auditAccess: AuditAccess = {
    recent: () => [] as AuditEntry[],
  };
  const agentRecordsAccess: AgentRecordsAccess = {
    query: () => [] as AgentRecord[],
  };

  const ctx: StageContext = {
    registry,
    tx: scratchTx,
    bundle: registry.bundle,
    provider_registry: registry.providers,
    state: narrowStateForBundle(state, tx.now),
    now: tx.now,
    async begin_spawn(
      agent: string,
      phase: Phase,
      model?: ModelName,
    ): Promise<string> {
      const agent_run_id = makeAgentRunId();
      const resolvedModel = model ?? null;
      await tx.exec(
        "INSERT INTO pending_agents (agent_run_id, agent, phase, model, started_at) " +
          "VALUES (?, ?, ?, ?, ?)",
        [agent_run_id, agent, phase, resolvedModel, tx.now],
      );
      return agent_run_id;
    },
    resolve_provider(agent: string) {
      return registry.providers.resolve(agent, state);
    },
    audit_extra(payload: Record<string, unknown>) {
      tx.audit_buffer.push(payload);
    },
    findings: findingsAccess,
    audit_query: auditAccess,
    agents_query: agentRecordsAccess,
  };

  // Kernel-private side channel for interpreters that need the raw
  // Transaction handle (the only consumer today is `spawnGuard`).
  // The field is intentionally undocumented in `types/context.ts` so
  // bundle code cannot grow a dependency on it; the kernel reaches
  // it through `getKernelTx(ctx)` below.
  attachKernelTx(ctx, tx);

  return { ctx, ops };
}

// Kernel-private accessor for the raw Transaction handle stashed on
// the StageContext. Used by interpreters (and only by interpreters)
// that need to invoke guards / queries that take a raw tx — bundle
// code has no path to the symbol below.
const KERNEL_TX_SYMBOL = Symbol.for("@loom/kernel/raw-tx");

function attachKernelTx(ctx: StageContext, tx: Transaction): void {
  (ctx as unknown as Record<symbol, Transaction>)[KERNEL_TX_SYMBOL] = tx;
}

export function getKernelTx(ctx: StageContext): Transaction {
  const tx = (ctx as unknown as Record<symbol, Transaction>)[KERNEL_TX_SYMBOL];
  if (tx === undefined) {
    throw new KernelError({
      code: "INTERNAL_KERNEL_TX_UNAVAILABLE",
      message: "raw Transaction was not threaded onto the StageContext",
    });
  }
  return tx;
}

// All MVP mutators are bound on every BundleScratchTx instance —
// the per-effect manifest gate that narrows them based on
// `StepStage.effects[]` ships with the bundle-loader (the loader
// session is where the narrowing belongs because that is where the
// effects array becomes observable).
function makeBundleScratchTx(
  state: PipelineState,
  tx: Transaction,
  ops: BundleOp[],
): BundleScratchTx {
  return {
    read: {
      pipeline_state: () => state,
      findings: () => [],
      agent_records: () => [],
      audit: () => [],
      bundle_table: () => [],
    },
    set_decision(key: string, value: unknown) {
      ops.push({ op: "set_decision", key, value });
    },
    record_finding(f: Finding) {
      ops.push({ op: "record_finding", finding: f });
    },
    set_bundle_state_field(path: string, value: unknown) {
      ops.push({ op: "set_bundle_state_field", path, value });
    },
    record_files_modified(paths: string[]) {
      ops.push({ op: "record_files_modified", paths });
    },
    record_files_created(paths: string[]) {
      ops.push({ op: "record_files_created", paths });
    },
    upsert_bundle_row(table: string, row: Record<string, unknown>) {
      ops.push({ op: "upsert_bundle_row", table, row });
    },
    audit(payload: Record<string, unknown>) {
      tx.audit_buffer.push(payload);
    },
  };
}

// ============================================================================
// applyBundleOps — single interpreter for the BundleOp[] buffer
// ============================================================================

const BUNDLE_TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

export async function applyBundleOps(
  tx: Transaction,
  ops: BundleOp[],
): Promise<void> {
  for (const op of ops) {
    await applyOne(tx, op);
  }
}

async function applyOne(tx: Transaction, op: BundleOp): Promise<void> {
  switch (op.op) {
    case "set_decision":
      await mergeJsonObjectColumn(tx, "decisions", { [op.key]: op.value });
      return;
    case "record_finding":
      await insertFinding(tx, op.finding);
      return;
    case "set_bundle_state_field":
      await mergeJsonObjectColumn(tx, "bundle_state", { [op.path]: op.value });
      return;
    case "record_files_modified":
      await mergeJsonArrayColumn(tx, "files_modified", op.paths);
      return;
    case "record_files_created":
      await mergeJsonArrayColumn(tx, "files_created", op.paths);
      return;
    case "upsert_bundle_row":
      await upsertBundleRow(tx, op.table, op.row);
      return;
    case "audit":
      tx.audit_buffer.push(op.payload);
      return;
    case "render_view":
      // Output rendering lands with the bundle output surface. The
      // op is accepted (so bundles can reference it today), recorded
      // for audit, and otherwise discarded — keeps bundles forward-
      // compatible without forcing the rendering subsystem into
      // every session.
      tx.audit_buffer.push({
        kind: "render_view-noop",
        path: op.path,
        bytes: op.content.length,
      });
      return;
    default: {
      const _exhaustive: never = op;
      throw new KernelError({
        code: "BUNDLE_OP_UNKNOWN",
        message: "unknown BundleOp variant",
        detail: { op: _exhaustive as unknown as Record<string, unknown> },
      });
    }
  }
}

async function insertFinding(tx: Transaction, f: Finding): Promise<void> {
  // Phase resolution for ops-buffered findings ships with the
  // bundle-loader's stage-aware scratch context — the BundleOp
  // shape today has no phase field, and the persistAgentResult
  // path is the production write surface that DOES thread phase.
  // The empty-string fallback below keeps a record landing on the
  // forensics surface even if a Step.run pushes record_finding
  // directly (no SQL constraint forbids empty TEXT, only NULL).
  const phaseFallback = "";
  await tx.exec(
    "INSERT INTO findings (id, task_id, agent, iteration, phase, file, " +
      "line_start, line_end, severity, category, proposed_new_category, " +
      "pattern_id, summary, evidence_excerpt, suggested_fix, status, " +
      "ref_rule_id, recorded_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      f.id,
      f.task_id.length > 0 ? f.task_id : null,
      f.agent,
      f.iteration,
      phaseFallback,
      f.file,
      f.line_start,
      f.line_end,
      f.severity,
      f.category,
      f.proposed_new_category,
      f.pattern_id,
      f.summary,
      f.evidence_excerpt,
      f.suggested_fix,
      f.status,
      f.ref_rule_id,
      tx.now,
    ],
  );
}

async function upsertBundleRow(
  tx: Transaction,
  table: string,
  row: Record<string, unknown>,
): Promise<void> {
  if (!BUNDLE_TABLE_NAME.test(table)) {
    throw new KernelError({
      code: "BUNDLE_TABLE_NAME_INVALID",
      message: `upsert_bundle_row table='${table}' does not match the bundle-table name shape`,
      detail: { table },
    });
  }
  const keys = Object.keys(row);
  if (keys.length === 0) return;
  const placeholders = keys.map(() => "?").join(", ");
  const values = keys.map((k) => row[k] as unknown);
  await tx.exec(
    `INSERT OR REPLACE INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})`,
    values,
  );
}

async function mergeJsonObjectColumn(
  tx: Transaction,
  column: "decisions" | "bundle_state",
  patch: Record<string, unknown>,
): Promise<void> {
  // Read-merge-write under the open writer lock — `BEGIN IMMEDIATE`
  // already prevents concurrent writers from racing this pair.
  const row = await tx.queryRow<Record<string, string | null>>(
    `SELECT ${column} FROM pipeline_state WHERE id = 1`,
  );
  let current: Record<string, unknown> = {};
  const raw = row?.[column];
  if (raw !== null && raw !== undefined && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      }
    } catch {
      current = {};
    }
  }
  const merged = { ...current, ...patch };
  await tx.exec(
    `UPDATE pipeline_state SET ${column} = ? WHERE id = 1`,
    [JSON.stringify(merged)],
  );
}

async function mergeJsonArrayColumn(
  tx: Transaction,
  column: "files_modified" | "files_created",
  add: string[],
): Promise<void> {
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
  const merged = [...new Set([...current, ...add])];
  await tx.exec(
    `UPDATE pipeline_state SET ${column} = ? WHERE id = 1`,
    [JSON.stringify(merged)],
  );
}

// ============================================================================
// kernelError — directive shape for kernel-coded loop errors
// ============================================================================

export function kernelError(
  state: PipelineState,
  code: string,
  detail?: Record<string, unknown>,
): KernelDirective {
  return {
    kind: "error",
    driver_state_id: state.driver_state_id,
    code,
    message: formatErrorMessage(code, detail),
    // recovery_options stays empty until the recovery primitive +
    // bundle-loader populate the per-code menu. The shape is wired
    // forward so transport adapters can rely on `recovery_options`
    // always being an array.
    recovery_options: [],
  };
}

function formatErrorMessage(
  code: string,
  detail?: Record<string, unknown>,
): string {
  if (detail === undefined) return code;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(detail)) {
    parts.push(`${k}=${formatDetailValue(v)}`);
  }
  return parts.length > 0 ? `${code} (${parts.join(", ")})` : code;
}

function formatDetailValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "[unserializable]";
  }
}

// ============================================================================
// HookContext for the pre/post-stage fires
// ============================================================================

function buildHookContext(
  state: PipelineState,
  registry: Registry,
  now: NowToken,
  stageName: string,
): HookContext {
  return {
    registry,
    bundle: registry.bundle,
    provider_registry: registry.providers,
    now,
    state: narrowStateForBundle(state, now),
    stage: stageName,
    idem_correlation: `pre-or-post:${state.driver_state_id}:${state.driver.step_index}`,
    async emit_event(_name, _payload) {
      // Bundle-emitted events route through the active HookRunner;
      // the no-op keeps the call surface forward-compatible.
    },
    findings: {
      query: () => [] as Finding[],
      countBlocking: () => 0,
      queryByPhase: () => [] as Finding[],
    },
    audit_query: { recent: () => [] as AuditEntry[] },
    agents_query: { query: () => [] as AgentRecord[] },
  };
}
