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
  archiveAndReset,
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
import { resetWorktree } from "./worktree.js";
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
  // `cached` = cache-READ tokens (a cache hit, billed cheap); `cache_write` =
  // cache-CREATION tokens (writing the prefix into the cache, billed at a
  // premium). They are distinct line items on a backend's bill, so a cost
  // roll-up that ignores cache_write under-counts spend on the first spawn of a
  // cached prefix. Driver-side only — the kernel models neutral in/out/cached.
  tokens?: { in: number; out: number; cached?: number; cache_write?: number };
  cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
}

// Drive-level usage roll-up — the SUM of every spawn's reported usage over one
// `drive()`. Surfaced on the outcome so a transport shows the WHOLE-task cost +
// token breakdown (incl. cache-write), not just the per-spawn lines. `cost_usd`
// is omitted when no backend reported a dollar figure (never a fabricated $0);
// the token fields are always present (zero when nothing was reported).
export interface DriveUsageTotal {
  // Number of spawns that reported any usage this drive.
  spawns: number;
  cost_usd?: number;
  tokens: { in: number; out: number; cached: number; cache_write: number };
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
//
// `signal` aborts an in-flight spawn: the loop passes a per-batch signal that
// fires on a wall-time budget breach or an external drive cancel, so a
// sandboxed CLI backend tears down its child instead of running it to
// completion (and burning tokens) past the cut. Honouring it is the contract
// that makes the spawn-budget actually bound spend; an executor that ignores
// it simply runs to completion as before.
export interface Executor {
  execute(spawn: ProviderShuttleIntent, signal?: AbortSignal): Promise<ExecutorResult>;
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
  // How to treat an IN-PROGRESS incumbent when a `task` is given. The headless
  // loop's default is to RESUME it (crash-recovery / re-attach is the point).
  // "archive" force-archives the incumbent and starts the new task instead —
  // the `loom run --replace` "discard the throwaway, start over" case. Never a
  // silent clobber: it only fires when the operator explicitly asked.
  on_active_task?: "resume" | "archive";
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
  // HARD ceiling on the TOTAL number of agent spawns a single drive may run
  // before it stops with DRIVE_SPAWN_CAP_EXCEEDED — a belt-and-suspenders
  // spend guard ON TOP OF the per-stage iteration/replan budgets. Those bound
  // each loop (review max 2-3 rounds → audit-only, replan max 3 → human), but
  // nothing bounded the SUM across a whole drive, so a compounding revise loop
  // (or a future flow bug) could quietly run up the bill. 0 / undefined → no
  // cap (the budgets still apply). The transport supplies the value + default.
  max_total_spawns?: number;
  signal?: AbortSignal;
}

export type DriveOutcome =
  | {
      kind: "complete";
      task_id: string | null;
      verdict: "accepted" | "rejected" | "failed_force_closed";
      summary: string;
      usage_total?: DriveUsageTotal;
    }
  | {
      kind: "paused";
      reason: "ask-user";
      driver_state_id: string;
      gate: string;
      gate_event_id: string;
      message: string;
      valid_answers: UserAnswerSchema;
      usage_total?: DriveUsageTotal;
    }
  | {
      kind: "error";
      driver_state_id: string;
      code: string;
      message: string;
      recovery_options: { choice: string; label: string; agent_run_ids?: string[] }[];
      usage_total?: DriveUsageTotal;
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
  // A truncated-at-max_tokens output: a provider cut its result at the token
  // cap. Re-running with the same cap truncates identically, so it is surfaced
  // by CODE and NOT spent against the in-loop retry budget (see below).
  "EXECUTOR_OUTPUT_TRUNCATED",
  ...PERMANENT_PROVIDER_ERROR_CODES,
]);

// Executor codes that re-running the SAME spawn cannot clear — surfaced at
// once, never spent against the in-loop fast-retry budget. A rate-limit clears
// only with a long wait (the supervisor's job), a permanent provider error
// never clears, and a max_tokens truncation re-truncates on every identical
// retry; all three want the caller's policy, not a tight retry.
const NO_RETRY_EXECUTOR_CODES = new Set<string>([
  "EXECUTOR_RATE_LIMITED",
  "EXECUTOR_OUTPUT_TRUNCATED",
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
  // `let`, not `const`: archiving the slot (auto-rotate / --replace below) wipes
  // the project store INCLUDING its installed-extension registrations, so the
  // registry must be RE-RESOLVED against the fresh store afterwards — a
  // reconciling resolver re-installs the bundle so the replacement task can
  // initialize. Without it, `initialize-task` refuses with "no enabled bundle".
  let registry = await opts.resolveRegistry(projectDir);
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
      // Discard the prior task's isolated copy so the new task starts from a
      // clean tree — otherwise its self-diff inherits the rotated task's edits.
      resetWorktree(projectDir);
      // The archive wiped the store (incl. installed extensions) — re-resolve so
      // the bundle is reconciled back into the fresh store before init.
      registry = await opts.resolveRegistry(projectDir);
      const created = await createAndStart(projectDir, createArgs(registry, uuid, opts));
      response = created.response;
      driverStateId = created.driver_state_id;
    }
  } else if (opts.on_active_task === "archive" && opts.task !== undefined) {
    // Explicit discard-and-restart: force-archive the in-progress incumbent
    // (it is preserved in history + its branch stays for review), then start
    // the new task. Only ever reached when the operator asked (`--replace`).
    await archiveAndReset(projectDir, captureNow(), { force: true });
    // Discard the incumbent's isolated copy so the replacement starts clean.
    resetWorktree(projectDir);
    // The force-archive wiped the store (incl. installed extensions) — re-resolve
    // so the bundle is reconciled back into the fresh store before init,
    // otherwise the replacement task refuses with "no enabled bundle".
    registry = await opts.resolveRegistry(projectDir);
    const created = await createAndStart(projectDir, createArgs(registry, uuid, opts));
    response = created.response;
    driverStateId = created.driver_state_id;
  } else {
    const loaded = await readState(projectDir);
    driverStateId = loaded.driver_state_id;
    const directive = await resumeDirective(loaded, registry, { reshuttle_safe: reshuttleSafe });
    response = shape(directive, { driver_state_id: driverStateId });
  }

  // ----- loop ------------------------------------------------------------
  let executorFailures = 0;
  // DISTINCT agent_run_ids spawned this drive — checked against the optional
  // hard cap below. Counted by id (not a running sum) so the executor-retry
  // path, which RE-shuttles the same pending rows, never double-counts a spawn
  // against the cap — a flaky backend that retries twice still counts once.
  const countedSpawns = new Set<string>();
  const spawnCap = opts.max_total_spawns ?? 0;

  // Running roll-up of every spawn's reported usage across this drive. Folded
  // after each batch; snapshotted onto the terminal outcome via `withUsage` so a
  // transport surfaces the WHOLE-task cost + token breakdown (incl. cache-write).
  const usageAcc = { spawns: 0, anyCost: false, cost_usd: 0, in: 0, out: 0, cached: 0, cache_write: 0 };
  const usageTotal = (): DriveUsageTotal | undefined => {
    if (usageAcc.spawns === 0) return undefined;
    return {
      spawns: usageAcc.spawns,
      ...(usageAcc.anyCost ? { cost_usd: usageAcc.cost_usd } : {}),
      tokens: { in: usageAcc.in, out: usageAcc.out, cached: usageAcc.cached, cache_write: usageAcc.cache_write },
    };
  };
  const withUsage = (o: DriveOutcome): DriveOutcome => {
    const ut = usageTotal();
    return ut !== undefined ? { ...o, usage_total: ut } : o;
  };

  for (;;) {
    if (opts.signal?.aborted) {
      return withUsage({
        kind: "error",
        driver_state_id: driverStateId,
        code: "DRIVE_ABORTED",
        message: "drive aborted by signal",
        recovery_options: [],
      });
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
        // Enforce the total-spawn ceiling BEFORE running the batch — a runaway
        // revise loop (or a flow bug) stops here instead of running up the bill.
        // The task stays in_progress (resumable): raise the cap or investigate.
        for (const id of agentRunIds) countedSpawns.add(id);
        if (spawnCap > 0 && countedSpawns.size > spawnCap) {
          return withUsage({
            kind: "error",
            driver_state_id: driverStateId,
            code: "DRIVE_SPAWN_CAP_EXCEEDED",
            message:
              `drive hit the spawn cap (${spawnCap}) — likely a revise loop that is not ` +
              `converging. The task is left in progress; investigate, or raise LOOM_MAX_SPAWNS ` +
              `(0 disables the cap) and resume.`,
            recovery_options: [],
          });
        }
        const intents = buildExecIntents(state, registry, agentRunIds);
        const cap = resolveConcurrencyCap(state, registry, opts.max_concurrent);
        const budgetMs = resolveSpawnBudgetMs(state, registry);

        let results: ExecutorResult[];
        try {
          results = await executeBatch(intents, opts.executor, cap, budgetMs, opts.signal);
        } catch (err) {
          // An external cancel (the drive's own signal) cut the batch — its
          // AbortController already killed the in-flight children. Stop now;
          // never re-drive an aborted run (it would re-spawn what we just
          // cancelled).
          if (opts.signal?.aborted) {
            return withUsage({
              kind: "error",
              driver_state_id: driverStateId,
              code: "DRIVE_ABORTED",
              message: "drive aborted by signal",
              recovery_options: [],
            });
          }
          if (err instanceof SpawnBudgetExceeded) {
            return withUsage({
              kind: "error",
              driver_state_id: driverStateId,
              code: "SPAWN_BUDGET_EXCEEDED",
              message: err.message,
              recovery_options: [],
            });
          }
          const execCode =
            err instanceof KernelError && SURFACEABLE_EXECUTOR_CODES.has(err.code)
              ? err.code
              : "EXECUTOR_FAILED";
          // A rate-limit will not clear within the fast in-loop retries, a
          // permanent provider error (bad model id, auth/billing) will not
          // clear AT ALL, and a max_tokens truncation re-truncates identically —
          // surface any of them at once so the caller applies its wait/park
          // policy instead of burning the retry budget on a wall the next
          // attempt hits identically.
          if (NO_RETRY_EXECUTOR_CODES.has(execCode)) {
            return withUsage({
              kind: "error",
              driver_state_id: driverStateId,
              code: execCode,
              message: (err as Error).message,
              recovery_options: [],
            });
          }
          executorFailures += 1;
          if (executorFailures > maxRetries) {
            return withUsage({
              kind: "error",
              driver_state_id: driverStateId,
              code: execCode,
              message: `executor failed after ${maxRetries} retries: ${(err as Error).message}`,
              recovery_options: [],
            });
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
        // Fold this batch's reported usage into the drive-level roll-up (cost +
        // tokens incl. cache-write), so the terminal outcome can surface the
        // whole-task spend, not just the per-spawn lines.
        for (const r of results) {
          const u = r.usage;
          if (u === undefined) continue;
          usageAcc.spawns += 1;
          if (u.cost_usd !== undefined) {
            usageAcc.cost_usd += u.cost_usd;
            usageAcc.anyCost = true;
          }
          if (u.tokens !== undefined) {
            usageAcc.in += u.tokens.in;
            usageAcc.out += u.tokens.out;
            usageAcc.cached += u.tokens.cached ?? 0;
            usageAcc.cache_write += u.tokens.cache_write ?? 0;
          }
        }
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
        return withUsage({
          kind: "paused",
          reason: "ask-user",
          driver_state_id: response.driver_state_id,
          gate: response.gate,
          gate_event_id: response.gate_event_id,
          message: response.message,
          valid_answers: response.valid_answers,
        });

      case "complete":
        return withUsage({
          kind: "complete",
          task_id: response.task_id,
          verdict: response.verdict,
          summary: response.summary,
        });

      case "error": {
        const errInfo: DriveError = {
          driver_state_id: response.driver_state_id,
          code: response.code,
          message: response.message,
          recovery_options: response.recovery_options,
        };
        const choice = opts.recoverChoice ? await opts.recoverChoice(errInfo) : null;
        if (choice === null || choice === undefined) {
          return withUsage({ kind: "error", ...errInfo });
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
// HOST project's `.loom/transcripts/`. Best-effort inside; a missing
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

// Run a batch at most `cap` at a time, preserving input order, and bound the
// whole batch by the stage's wall-time budget when one is declared.
//
// One AbortController bounds the WHOLE batch and is threaded into every
// `executor.execute`: a wall-time budget breach OR the parent drive's cancel
// aborts it, which a sandboxed CLI backend turns into a SIGTERM on its child —
// so an over-budget / cancelled fanout STOPS BURNING TOKENS instead of leaving
// its already-running children to run to completion (the leak the abort-less
// budget had). A rejected execute still bubbles up (the loop re-resumes +
// retries); a budget overrun aborts the in-flight children THEN throws
// SpawnBudgetExceeded (the loop cuts the fanout).
async function executeBatch(
  intents: ProviderShuttleIntent[],
  executor: Executor,
  cap: number,
  budgetMs: number | null,
  parentSignal: AbortSignal | undefined,
): Promise<ExecutorResult[]> {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort();
  if (parentSignal !== undefined) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

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
        results[i] = await executor.execute(intent, controller.signal);
      }
    };
    const lanes = Math.max(1, Math.min(cap, intents.length));
    await Promise.all(Array.from({ length: lanes }, () => worker()));
    return results;
  };

  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (budgetMs === null) return await run();
    return await new Promise<ExecutorResult[]>((resolve, reject) => {
      budgetTimer = setTimeout(() => {
        // Cut the fanout: abort the in-flight children FIRST (so they stop
        // billing), then surface the over-budget error to the loop.
        controller.abort();
        reject(new SpawnBudgetExceeded(budgetMs));
      }, budgetMs);
      run().then(resolve, (e) => reject(e instanceof Error ? e : new Error(String(e))));
    });
  } finally {
    if (budgetTimer !== undefined) clearTimeout(budgetTimer);
    if (parentSignal !== undefined) parentSignal.removeEventListener("abort", onParentAbort);
  }
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
