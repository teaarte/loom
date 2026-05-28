// FSM core: the tick loop, the stage-context constructor, the
// `interpretStage` dispatcher, and the helper that shapes kernel-coded
// errors into `KernelDirective`s.
//
// The loop is intentionally thin — every Stage variant has its own
// interpreter in `./stages/`; the BundleOp dispatcher lives in
// `./lib/apply-bundle-ops.js`; the per-tick access-snapshot builder
// lives in `./lib/access-snapshots.js`. Two load-bearing invariants
// live here:
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
import { applyBundleOps } from "./lib/apply-bundle-ops.js";
import {
  emptyAgentRecordsAccess,
  emptyAuditAccess,
  emptyFindingsAccess,
  materializeAccessSnapshot,
} from "./lib/access-snapshots.js";
import { dispatchEventSteps } from "./lib/dispatch-event-steps.js";
import { narrowStateForBundle } from "./narrow.js";
import { interpretFanout } from "./stages/fanout.js";
import { interpretFinalize } from "./stages/finalize.js";
import { interpretGate } from "./stages/gate.js";
import { interpretSpawn } from "./stages/spawn.js";
import { interpretStep } from "./stages/step.js";
import { captureNow, KernelError } from "./state/db.js";
import { withStateTransaction } from "./state/transaction.js";
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
import type { Transaction } from "./types/transaction.js";
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

    const beforeCtx = await buildHookContext(state, registry, now, stageName);
    await hookRunner.fire(`before-${stage.kind}`, beforeCtx);

    const stageResult = await withStateTransaction(
      state.project_dir,
      now,
      async (tx) => {
        const { ctx, ops } = await buildStageContext(state, registry, tx);
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

    const afterCtx = await buildHookContext(state, registry, now, stageName);
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

export async function buildStageContext(
  state: PipelineState,
  registry: Registry,
  tx: Transaction,
): Promise<BuiltStageContext> {
  const ops: BundleOp[] = [];
  const scratchTx: BundleScratchTx = makeBundleScratchTx(state, tx, ops);

  // Pre-materialize the three access surfaces once at the start of the
  // stage tick. Three SELECTs per tick is the price of giving the
  // policy hot-path a synchronous accessor surface — the alternative
  // is threading a Promise through every `ctx.findings.*` call.
  const {
    findings: findingsAccess,
    audit_query: auditAccess,
    agents_query: agentRecordsAccess,
  } = await materializeAccessSnapshot(tx);

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
      // The four heavy read accessors fail loud rather than returning
      // an empty collection. An empty array could be read as "no rows
      // exist" when in fact no SELECT ran; the throw routes that
      // ambiguity to a typed refusal until pre-materialization wires
      // through this surface. `pipeline_state` stays real — the
      // snapshot is already on hand.
      findings: () => {
        throw new KernelError({
          code: "READ_NOT_WIRED",
          message:
            "BundleScratchTx.read.findings is not wired — pre-materialization for the bundle-facing read surface has not landed",
          detail: { accessor: "findings" },
        });
      },
      agent_records: () => {
        throw new KernelError({
          code: "READ_NOT_WIRED",
          message:
            "BundleScratchTx.read.agent_records is not wired — pre-materialization for the bundle-facing read surface has not landed",
          detail: { accessor: "agent_records" },
        });
      },
      audit: () => {
        throw new KernelError({
          code: "READ_NOT_WIRED",
          message:
            "BundleScratchTx.read.audit is not wired — pre-materialization for the bundle-facing read surface has not landed",
          detail: { accessor: "audit" },
        });
      },
      bundle_table: () => {
        throw new KernelError({
          code: "READ_NOT_WIRED",
          message:
            "BundleScratchTx.read.bundle_table is not wired — pre-materialization for the bundle-facing read surface has not landed",
          detail: { accessor: "bundle_table" },
        });
      },
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

async function buildHookContext(
  state: PipelineState,
  registry: Registry,
  now: NowToken,
  stageName: string,
): Promise<HookContext> {
  // Hooks fire outside the stage transaction; materialize the access
  // snapshot from a fresh read-only tx so the three accessors see the
  // post-commit (for `after-X` fires) or pre-stage (for `before-X`
  // fires) state on disk. Skipped entirely when no hooks are
  // registered — most test fixtures and bundles without subscribers
  // pay zero SELECT cost.
  let findingsAccess: FindingsAccess;
  let auditAccess: AuditAccess;
  let agentRecordsAccess: AgentRecordsAccess;
  if (registry.hooks.length === 0) {
    findingsAccess = emptyFindingsAccess();
    auditAccess = emptyAuditAccess();
    agentRecordsAccess = emptyAgentRecordsAccess();
  } else {
    const snap = await withStateTransaction(state.project_dir, now, (tx) =>
      materializeAccessSnapshot(tx),
    );
    findingsAccess = snap.findings;
    auditAccess = snap.audit_query;
    agentRecordsAccess = snap.agents_query;
  }
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
    findings: findingsAccess,
    audit_query: auditAccess,
    agents_query: agentRecordsAccess,
  };
}
