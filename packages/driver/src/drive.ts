// `drive(projectDir, opts)` — the transport-neutral, bundle-blind
// orchestration loop. It spins the directive contract — spawn / ask /
// complete / error — and knows ZERO domain vocabulary: it never learns what
// "review" or "adjudicate" mean, because every semantic decision is
// resolved server-side by the kernel. This is the body a daemon wraps and
// the reference for a conformant driver.
//
// The ONE host-difference axis is the injected `Executor`: "how a spawn is
// run". A host Task-tool executor (model = executor) and a provider-backed
// executor (headless) drive the SAME loop. The loop reuses the kernel's own
// `agent_run_id` verbatim — it never mints one — and re-derives each prompt
// from canonical state right before executing, so a resume re-shuttle stub
// and a by-reference fanout are both moot.
//
// Restart is free: `peekArchiveSlot` + the resume-form re-emit means a
// dropped task re-attaches by reading the kernel, not by replaying driver
// memory. An executor failure re-resumes (same `agent_run_id`, no fresh
// begin_spawn) and the re-delivery dedups through the idempotency ledger.
//
// Ambient clock is fine here: the loop is a transport, OUTSIDE the kernel's
// replay graph.

import { randomUUID } from "node:crypto";

import {
  archiveStateDb,
  buildPrompt,
  captureNow,
  KERNEL_BUDGET_CEILINGS,
  KernelError,
  peekArchiveSlot,
  resolveSpawnModel,
  type FanoutStage,
  type GateRole,
  type PipelineState,
  type PolicyName,
  type ProviderShuttleIntent,
  type RecoveryChoice,
  type Registry,
  type UserAnswerSchema,
} from "@loomfsm/kernel";
import type { TransportResponse } from "@loomfsm/transport-types";

import { shape } from "./adapter.js";
import {
  createAndStart,
  deliverAndAdvance,
  readState,
  recoverAndAdvance,
} from "./compositions.js";
import { PERMANENT_PROVIDER_ERROR_CODES } from "./provider-error.js";
import { resumeDirective } from "./resume-directive.js";
import { writeSpawnTranscript } from "./transcript.js";

// Per-spawn resource accounting a backend can surface when its envelope
// carries it (e.g. `claude -p --output-format json` reports `usage` +
// `total_cost_usd`). The token shape mirrors the kernel's `AgentResult.tokens`
// so a future delivery-input field carries it straight through to the store;
// `cost_usd` is a backend-computed figure the kernel does not model (it tracks
// neutral tokens), surfaced here for audit/observability only.
//
// `agent` / `model` are the spawn's identity, stamped at the executor boundary
// (where the intent is in scope) so the observability sink — which fires after
// the spawn, decoupled from the intent — can show WHICH agent + model the usage
// was for. The kernel delivery path reads only `tokens`; the identity rides for
// the audit line / log view and is otherwise inert.
export interface SpawnUsage {
  agent?: string;
  model?: string;
  tokens?: { in: number; out: number; cached?: number };
  cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
}

// What an executor returns. `agent_output` is the spawn's text; the file
// lists are OPTIONAL host-authoritative accounting the loop unions with the
// server-computed git delta (set semantics, so reporting nothing is safe).
// `usage` is OPTIONAL per-spawn cost/token accounting a backend surfaces when
// its envelope carries it — the loop does not yet deliver it into the kernel
// (the delivery input has no token field), so it is currently observed via the
// executor's own `onUsage` sink, not persisted.
export interface ExecutorResult {
  agent_output: string;
  files_modified?: string[];
  files_created?: string[];
  usage?: SpawnUsage;
}

// The single injected seam — "how to run one spawn". The input is the
// kernel's own shuttle intent, carrying the REUSED agent_run_id; the
// executor must echo no fresh id. The loop bounds concurrency, so the
// executor stays single-spawn.
export interface Executor {
  execute(spawn: ProviderShuttleIntent): Promise<ExecutorResult>;
  // True when re-running a spawn (same agent_run_id) is SAFE — e.g. a
  // sandboxed worktree executor whose re-run just redoes the work in an
  // isolated tree. It lets the resume restart-head re-shuttle a pending spawn
  // even under a provider declared non-idempotent (the create→attach gap a
  // daemon/control-plane always hits, and crash-recovery of a pending spawn).
  // Omitted/false → the provider's idempotency gate stands.
  idempotent?: boolean;
}

// The shape passed to a caller's recovery policy when the loop hits an
// error directive — enough to decide a `RecoveryChoice` without reaching
// into kernel state.
export interface DriveError {
  driver_state_id: string;
  code: string;
  message: string;
  recovery_options: { choice: string; label: string; agent_run_ids?: string[] }[];
}

export interface DriveOptions {
  executor: Executor;
  // The caller owns the bundle + provider set; the loop stays agnostic.
  resolveRegistry: (projectDir: string) => Promise<Registry> | Registry;
  // Present → start a fresh task (or rotate a finished slot and start one).
  // Absent → attach to the active task and resume it.
  task?: string;
  policy_preset?: string;
  gate_policies?: Partial<Record<GateRole, PolicyName>>;
  complexity_hint?: "simple" | "medium" | "complex";
  // Generic opening-decisions seed; the loop names none of its keys and
  // passes it straight through to the kernel's task-create.
  initial_decisions?: Record<string, unknown>;
  owner_id?: string;
  // Reuse VERBATIM on a retry of the same logical drive; minted per call
  // when absent. Keys the task-create idempotency ledger.
  client_idempotency_uuid?: string;
  identifier?: string;
  // Caller's recovery policy. Returns a choice to recover and continue, or
  // null to surface the error and stop. A HUMAN gate is never routed here —
  // it pauses (escalation), never auto-answers.
  recoverChoice?: (err: DriveError) => RecoveryChoice | null | Promise<RecoveryChoice | null>;
  // Driver-level concurrency ceiling, min'd with the stage's declared
  // `max_concurrent_spawns` and the kernel's global fanout ceiling.
  max_concurrent?: number;
  // Re-resume + re-execute budget for a failing executor before the loop
  // surfaces EXECUTOR_FAILED. Default 2.
  max_executor_retries?: number;
  signal?: AbortSignal;
}

export type DriveOutcome =
  | {
      kind: "complete";
      task_id: string | null;
      verdict: "accepted" | "rejected" | "failed_force_closed";
      summary: string;
    }
  | {
      kind: "paused";
      reason: "ask-user";
      driver_state_id: string;
      gate: string;
      gate_event_id: string;
      message: string;
      valid_answers: UserAnswerSchema;
    }
  | {
      kind: "error";
      driver_state_id: string;
      code: string;
      message: string;
      recovery_options: { choice: string; label: string; agent_run_ids?: string[] }[];
    };

// Executor-thrown KernelError codes the caller's retry policy must act on
// differently from a generic blip — a sustained rate-limit (wait, don't
// retry), a wedged-spawn timeout, or a PERMANENT provider error (bad model id,
// auth/billing) that no retry can clear. These are preserved through to the
// error outcome; every other executor throw stays the generic EXECUTOR_FAILED.
// By CODE only — the loop never reads what a spawn meant, only how it failed.
const SURFACEABLE_EXECUTOR_CODES = new Set<string>([
  "EXECUTOR_RATE_LIMITED",
  "EXECUTOR_TIMEOUT",
  "EXECUTOR_IDLE_TIMEOUT",
  ...PERMANENT_PROVIDER_ERROR_CODES,
]);

// A spawn batch that ran past its stage's wall-time `spawn_budget`. Thrown
// inside the batch runner and turned into a terminal drive error — the
// generic "cut an over-budget fanout" the runner enforces driver-side.
class SpawnBudgetExceeded extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`spawn batch exceeded its ${timeoutMs}ms budget`);
    this.name = "SpawnBudgetExceeded";
  }
}

export async function drive(projectDir: string, opts: DriveOptions): Promise<DriveOutcome> {
  const registry = await opts.resolveRegistry(projectDir);
  const uuid = opts.client_idempotency_uuid ?? `cidem-${randomUUID()}`;
  const maxRetries = opts.max_executor_retries ?? 2;
  // The executor's promise that re-running a spawn is safe — lets the resume
  // restart-head re-shuttle a pending spawn under a non-idempotent provider
  // (the create→attach gap, executor-retry, and crash-recovery all rely on it).
  const reshuttleSafe = opts.executor.idempotent === true;

  // ----- entry: create-or-attach ----------------------------------------
  let response: TransportResponse;
  let driverStateId = "d-unknown";

  const slot = await peekArchiveSlot(projectDir);
  if (slot === null) {
    if (opts.task === undefined) {
      return {
        kind: "error",
        driver_state_id: driverStateId,
        code: "NO_ACTIVE_TASK",
        message: "no active task to resume and no task to start",
        recovery_options: [],
      };
    }
    const created = await createAndStart(projectDir, createArgs(registry, uuid, opts));
    response = created.response;
    driverStateId = created.driver_state_id;
  } else if (slot.status === "completed" || slot.status === "abandoned") {
    if (opts.task === undefined) {
      // Already finished and nothing new asked — report the terminal verdict.
      response = completeResponseFromState(await readState(projectDir));
    } else {
      // Free the finished slot, then start the new task — mirrors the
      // stdio create path's belt-and-suspenders auto-rotate. A live task is
      // NEVER rotated (that branch is unreachable here: in_progress falls
      // through to resume below).
      await archiveStateDb(projectDir, captureNow(), { reason: "auto-rotate" });
      const created = await createAndStart(projectDir, createArgs(registry, uuid, opts));
      response = created.response;
      driverStateId = created.driver_state_id;
    }
  } else {
    const loaded = await readState(projectDir);
    driverStateId = loaded.driver_state_id;
    const directive = await resumeDirective(loaded, registry, { reshuttle_safe: reshuttleSafe });
    response = shape(directive, { driver_state_id: driverStateId });
  }

  // ----- loop ------------------------------------------------------------
  let executorFailures = 0;
  for (;;) {
    if (opts.signal?.aborted) {
      return {
        kind: "error",
        driver_state_id: driverStateId,
        code: "DRIVE_ABORTED",
        message: "drive aborted by signal",
        recovery_options: [],
      };
    }

    switch (response.status) {
      case "spawn-agent":
      case "spawn-agents-parallel": {
        driverStateId = response.driver_state_id;
        const state = await readState(projectDir);
        const agentRunIds =
          response.status === "spawn-agent"
            ? [response.agent_run_id]
            : response.spawns.map((s) => s.agent_run_id);
        const intents = buildExecIntents(state, registry, agentRunIds);
        const cap = resolveConcurrencyCap(state, registry, opts.max_concurrent);
        const budgetMs = resolveSpawnBudgetMs(state, registry);

        let results: ExecutorResult[];
        try {
          results = await executeBatch(intents, opts.executor, cap, budgetMs);
        } catch (err) {
          if (err instanceof SpawnBudgetExceeded) {
            return {
              kind: "error",
              driver_state_id: driverStateId,
              code: "SPAWN_BUDGET_EXCEEDED",
              message: err.message,
              recovery_options: [],
            };
          }
          const execCode =
            err instanceof KernelError && SURFACEABLE_EXECUTOR_CODES.has(err.code)
              ? err.code
              : "EXECUTOR_FAILED";
          // A rate-limit will not clear within the fast in-loop retries, and a
          // permanent provider error (bad model id, auth/billing) will not
          // clear AT ALL — surface either at once so the caller applies its
          // wait/park policy instead of burning the retry budget on a wall the
          // next attempt hits identically.
          if (execCode === "EXECUTOR_RATE_LIMITED" || PERMANENT_PROVIDER_ERROR_CODES.has(execCode)) {
            return {
              kind: "error",
              driver_state_id: driverStateId,
              code: execCode,
              message: (err as Error).message,
              recovery_options: [],
            };
          }
          executorFailures += 1;
          if (executorFailures > maxRetries) {
            return {
              kind: "error",
              driver_state_id: driverStateId,
              code: execCode,
              message: `executor failed after ${maxRetries} retries: ${(err as Error).message}`,
              recovery_options: [],
            };
          }
          // Re-resume restart-head: re-shuttle the still-pending rows
          // REUSING each agent_run_id (no fresh begin_spawn → no
          // duplicate-window trip), then retry the batch.
          const reloaded = await readState(projectDir);
          response = shape(await resumeDirective(reloaded, registry, { reshuttle_safe: reshuttleSafe }), {
            driver_state_id: reloaded.driver_state_id,
          });
          continue;
        }

        executorFailures = 0;
        // Write the per-spawn transcript sidecar (prompt + raw output + the
        // structured parse + usage) to the HOST project before delivering — so
        // an operator can read WHAT each spawn produced at the gate / in the
        // trace, and diagnose a spawn that did nothing. Best-effort, never on
        // the kernel path.
        writeSpawnTranscripts(projectDir, intents, results);
        const delivered = await deliverAndAdvance(projectDir, {
          registry,
          input: toContinueInput(response, results),
          driver_state_id: driverStateId,
          ...(opts.identifier !== undefined ? { identifier: opts.identifier } : {}),
        });
        response = delivered.response;
        continue;
      }

      case "ask-user":
        return {
          kind: "paused",
          reason: "ask-user",
          driver_state_id: response.driver_state_id,
          gate: response.gate,
          gate_event_id: response.gate_event_id,
          message: response.message,
          valid_answers: response.valid_answers,
        };

      case "complete":
        return {
          kind: "complete",
          task_id: response.task_id,
          verdict: response.verdict,
          summary: response.summary,
        };

      case "error": {
        const errInfo: DriveError = {
          driver_state_id: response.driver_state_id,
          code: response.code,
          message: response.message,
          recovery_options: response.recovery_options,
        };
        const choice = opts.recoverChoice ? await opts.recoverChoice(errInfo) : null;
        if (choice === null || choice === undefined) {
          return { kind: "error", ...errInfo };
        }
        driverStateId = response.driver_state_id;
        const agentRunIds = recoveryAgentRunIds(response.recovery_options, choice);
        const recovered = await recoverAndAdvance(projectDir, {
          registry,
          driver_state_id: driverStateId,
          choice,
          ...(agentRunIds !== undefined ? { agent_run_ids: agentRunIds } : {}),
          ...(opts.identifier !== undefined ? { identifier: opts.identifier } : {}),
        });
        response = recovered.response;
        continue;
      }

      default: {
        const _exhaustive: never = response;
        return _exhaustive;
      }
    }
  }
}

// ----- spawn execution ---------------------------------------------------

// Write each spawn's transcript sidecar, pairing the intent (agent / model /
// prompt — the REUSED agent_run_id) with the executor's result (raw output +
// the self-diff file accounting + usage). One file per agent_run_id under the
// HOST project's `.claude/loom/transcripts/`. Best-effort inside; a missing
// pair is skipped. `captureNow()` mints the ISO stamp (transport mint point —
// outside the kernel's replay graph).
function writeSpawnTranscripts(
  projectDir: string,
  intents: ProviderShuttleIntent[],
  results: ExecutorResult[],
): void {
  for (let i = 0; i < intents.length; i += 1) {
    const intent = intents[i];
    const result = results[i];
    if (intent === undefined || result === undefined) continue;
    // Prefer the model the executor REPORTS it ran (the usage sink stamps it),
    // so a fallback that advanced to a different backend records the model that
    // actually ran rather than the primary the kernel resolved.
    const ranModel = result.usage?.model ?? intent.model;
    writeSpawnTranscript(projectDir, {
      agent: intent.agent,
      agent_run_id: intent.agent_run_id,
      phase: intent.phase,
      model: ranModel === "" ? null : ranModel,
      prompt: intent.prompt,
      raw_output: result.agent_output,
      parse_result: {
        ...(result.files_modified !== undefined ? { files_modified: result.files_modified } : {}),
        ...(result.files_created !== undefined ? { files_created: result.files_created } : {}),
      },
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
      recorded_at: captureNow(),
    });
  }
}

// Reconstruct the full shuttle intents for the named agent_run_ids from
// canonical state: the pending row supplies agent / phase / model (REUSING
// the agent_run_id), and the prompt is RE-DERIVED via `buildPrompt` — the
// same pure render the spawn interpreter ran, so a resume re-shuttle stub
// never reaches the executor.
function buildExecIntents(
  state: PipelineState,
  registry: Registry,
  agentRunIds: string[],
): ProviderShuttleIntent[] {
  const byId = new Map(state.pending_agents.map((r) => [r.agent_run_id, r]));
  return agentRunIds.map((arid) => {
    const row = byId.get(arid);
    if (row === undefined) {
      throw new KernelError({
        code: "RESUME_STALE",
        message: `agent_run_id '${arid}' is no longer pending`,
        detail: { agent_run_id: arid },
      });
    }
    const agentDef = registry.agents.get(row.agent);
    if (agentDef === undefined) {
      throw new KernelError({
        code: "AGENT_NOT_REGISTERED",
        message: `agent '${row.agent}' is not in the active registry`,
        detail: { agent: row.agent },
      });
    }
    const intent: ProviderShuttleIntent = {
      agent: row.agent,
      agent_run_id: row.agent_run_id,
      phase: row.phase,
      model: row.model ?? resolveSpawnModel(registry, row.agent, row.phase, state),
      prompt: buildPrompt(state, agentDef, registry),
    };
    if (agentDef.system_prompt !== undefined) intent.system_prompt = agentDef.system_prompt;
    if (agentDef.mcp_tools !== undefined) intent.mcp_tools_available = agentDef.mcp_tools;
    return intent;
  });
}

// Run a batch at most `cap` at a time, preserving input order, and bound
// the whole batch by the stage's wall-time budget when one is declared. A
// rejected execute bubbles up (the loop re-resumes + retries); a budget
// overrun throws SpawnBudgetExceeded (the loop cuts the fanout).
async function executeBatch(
  intents: ProviderShuttleIntent[],
  executor: Executor,
  cap: number,
  budgetMs: number | null,
): Promise<ExecutorResult[]> {
  const run = async (): Promise<ExecutorResult[]> => {
    const results = new Array<ExecutorResult>(intents.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = cursor;
        cursor += 1;
        if (i >= intents.length) return;
        const intent = intents[i];
        if (intent === undefined) return;
        results[i] = await executor.execute(intent);
      }
    };
    const lanes = Math.max(1, Math.min(cap, intents.length));
    await Promise.all(Array.from({ length: lanes }, () => worker()));
    return results;
  };
  if (budgetMs === null) return run();
  return await raceWithTimeout(run(), budgetMs);
}

function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SpawnBudgetExceeded(ms)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

// ----- generic budget reads (bundle-blind) -------------------------------

// The active stage, when it is a fanout — resolved positionally from the
// flow + step_index. The loop reads ONLY its numeric/time budget fields; it
// never reads what the stage means.
function activeFanoutStage(state: PipelineState, registry: Registry): FanoutStage | null {
  const flow = registry.flows.get(state.driver.flow_name);
  if (flow === undefined) return null;
  const stageName = flow[state.driver.step_index];
  if (stageName === undefined) return null;
  const stage = registry.stages.get(stageName);
  if (stage === undefined || stage.kind !== "fanout") return null;
  return stage;
}

function resolveConcurrencyCap(
  state: PipelineState,
  registry: Registry,
  injected: number | undefined,
): number {
  let cap: number = KERNEL_BUDGET_CEILINGS.fanout_concurrency_global;
  const stage = activeFanoutStage(state, registry);
  if (stage?.max_concurrent_spawns !== undefined) cap = Math.min(cap, stage.max_concurrent_spawns);
  if (injected !== undefined) cap = Math.min(cap, injected);
  return Math.max(1, cap);
}

function resolveSpawnBudgetMs(state: PipelineState, registry: Registry): number | null {
  const stage = activeFanoutStage(state, registry);
  if (stage?.spawn_budget?.kind === "time") return stage.spawn_budget.timeout_ms;
  return null;
}

// ----- shaping helpers ---------------------------------------------------

function toContinueInput(
  response: Extract<TransportResponse, { status: "spawn-agent" | "spawn-agents-parallel" }>,
  results: ExecutorResult[],
): import("@loomfsm/kernel").ContinueTaskInput {
  if (response.status === "spawn-agent") {
    const r = results[0] ?? { agent_output: "" };
    return {
      type: "agent-result",
      agent_run_id: response.agent_run_id,
      agent_output: r.agent_output,
      ...(r.files_modified !== undefined ? { files_modified: r.files_modified } : {}),
      ...(r.files_created !== undefined ? { files_created: r.files_created } : {}),
      // Forward the executor's captured per-spawn usage so the store persists
      // tokens (previously dropped — usage was observed only via the audit log).
      ...(r.usage?.tokens !== undefined ? { tokens: r.usage.tokens } : {}),
    };
  }
  return {
    type: "agents-results",
    results: response.spawns.map((s, i) => {
      const r = results[i] ?? { agent_output: "" };
      return {
        agent_run_id: s.agent_run_id,
        agent_output: r.agent_output,
        ...(r.files_modified !== undefined ? { files_modified: r.files_modified } : {}),
        ...(r.files_created !== undefined ? { files_created: r.files_created } : {}),
        ...(r.usage?.tokens !== undefined ? { tokens: r.usage.tokens } : {}),
      };
    }),
  };
}

function recoveryAgentRunIds(
  options: { choice: string; agent_run_ids?: string[] }[],
  choice: RecoveryChoice,
): string[] | undefined {
  return options.find((o) => o.choice === choice)?.agent_run_ids;
}

function completeResponseFromState(state: PipelineState): TransportResponse {
  return {
    status: "complete",
    task_id: state.task_id,
    verdict: state.verdict ?? "rejected",
    summary: state.status === "completed" ? "task already completed" : "task already abandoned",
  };
}

function createArgs(
  registry: Registry,
  uuid: string,
  opts: DriveOptions,
): import("./compositions.js").CreateAndStartArgs {
  return {
    registry,
    task: opts.task ?? "",
    client_idempotency_uuid: uuid,
    ...(opts.owner_id !== undefined ? { owner_id: opts.owner_id } : {}),
    ...(opts.policy_preset !== undefined ? { policy_preset: opts.policy_preset } : {}),
    ...(opts.gate_policies !== undefined ? { gate_policies: opts.gate_policies } : {}),
    ...(opts.complexity_hint !== undefined ? { complexity_hint: opts.complexity_hint } : {}),
    ...(opts.initial_decisions !== undefined ? { initial_decisions: opts.initial_decisions } : {}),
    ...(opts.identifier !== undefined ? { identifier: opts.identifier } : {}),
  };
}
