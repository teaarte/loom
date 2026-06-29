// FanoutStage interpreter — phase-1 of the parallel-spawn pattern.
//
// Filters the declared agent list by `Agent.applies_to` and (when
// the stage opts in) by `filter_by_change_kind`, then launches each
// surviving sibling via `ctx.begin_spawn`. Every sibling gets a
// fresh `agent_run_id`; SpawnGuard runs with the fanout-aware config
// so two siblings of the same agent name do not trip the duplicate-
// window check against each other.
//
// The interpreter returns `StageResult.shuttle-batch` carrying every
// surviving sibling's `ProviderShuttleIntent`. The transport adapter
// dispatches them concurrently (with global / provider / stage
// concurrency caps). Resume — `on_results` + per-sibling
// `persistAgentResult` — runs later, under the
// `pipeline_continue_task({type:"agents-results"})` delivery path.

import { KERNEL_BUDGET_CEILINGS } from "../budgets.js";
import { getKernelTx } from "../fsm.js";
import { spawnGuard } from "../guards.js";
import { buildPrompt } from "../prompt-renderer.js";
import type { AttemptBudget } from "../types/budget.js";
import type { StageContext } from "../types/context.js";
import type { FanoutStage, StageResult } from "../types/plugins.js";
import type { ProviderShuttleIntent } from "../types/provider.js";
import type { PipelineState } from "../types/state.js";
import type { Transaction } from "../types/transaction.js";

export async function interpretFanout(
  stage: FanoutStage,
  state: PipelineState,
  ctx: StageContext,
): Promise<StageResult> {
  if (stage.agents.length === 0) {
    return { type: "advance" };
  }

  const rawTx = getKernelTx(ctx);

  // Iteration budget — bound how many times a walk-back loop may re-enter
  // this fanout. The per-stage counter lives in
  // `driver_state.scratch.fanout_iter_<stage>`; on reaching the cap the
  // stage takes its `on_exhaustion` branch instead of spawning again. This
  // is a SECOND ceiling on the rework loop alongside the gate's auto-reject
  // replan cap — see the iteration-budget × replan-cap ADR for how they
  // compose. Checked before spawning so an exhausted fanout never re-issues.
  const budget = stage.iteration_budget;
  if (budget !== undefined) {
    const scratchKey = `fanout_iter_${stage.name}`;
    const count = readFanoutIterCount(state, scratchKey);
    const cap = Math.min(
      budget.max_iterations,
      budget.kernel_ceiling ?? KERNEL_BUDGET_CEILINGS.fanout_iteration,
    );
    if (count >= cap) {
      return fanoutExhaustionResult(stage, budget, count, cap, state);
    }
    await bumpFanoutIterCount(rawTx, state, scratchKey, count + 1);
  }

  const changeKind =
    typeof ctx.state.decisions["change_kind"] === "string"
      ? (ctx.state.decisions["change_kind"] as string)
      : null;

  const spawns: ProviderShuttleIntent[] = [];
  for (const agentName of stage.agents) {
    const agent = ctx.registry.agents.get(agentName);
    if (!agent) {
      return {
        type: "halt",
        directive: {
          code: "AGENT_NOT_REGISTERED",
          message: `FanoutStage '${stage.name}' references unregistered agent '${agentName}'`,
          recovery_options: [],
        },
      };
    }
    if (stage.filter_by_change_kind === true && changeKind !== null) {
      const relevant = agent.relevant_for_change_kinds;
      if (relevant !== undefined && !relevant.includes(changeKind)) continue;
    }
    if (agent.applies_to && !agent.applies_to(ctx.state)) continue;

    const agent_run_id = await ctx.begin_spawn(agentName, stage.phase);
    // Fanout-aware guard: siblings of the same agent name with
    // different agent_run_ids must not trip the duplicate window
    // against each other.
    await spawnGuard(rawTx, agentName, stage.phase, {
      fanout_agent_run_id: agent_run_id,
    });

    // Provider + model from the same route (agent + phase), mirroring the
    // single-spawn path; falls back to the agent default then the generic.
    const provider = ctx.registry.providers.resolve(agentName, state, stage.phase);
    const model =
      ctx.registry.providers.resolveModel?.(agentName, state, stage.phase) ??
      agent.default_model ??
      "default";

    // The agent's opaque passthrough rides first; the kernel's own keys
    // (provider, template_path) are authoritative and set after, so a bundle
    // cannot shadow them.
    const extras: Record<string, unknown> = { ...(agent.extras ?? {}), provider: provider.name };
    if (agent.template_path.length > 0) {
      extras["template_path"] = agent.template_path;
    }

    const intent: ProviderShuttleIntent = {
      agent: agentName,
      agent_run_id,
      phase: stage.phase,
      model,
      // Render the agent's materialized template, same as the single-
      // spawn path — a fanout sibling is as much a real agent run as a
      // lone spawn and needs its instructions, not an identifier stub.
      prompt: buildPrompt(state, agent, ctx.registry),
      extras,
    };
    if (agent.system_prompt !== undefined) {
      intent.system_prompt = agent.system_prompt;
    }
    if (agent.mcp_tools !== undefined) {
      intent.mcp_tools_available = agent.mcp_tools;
    }

    spawns.push(intent);
  }

  if (spawns.length === 0) {
    // Every sibling was filtered out — nothing to wait for; skip the
    // fanout entirely. This matches the `applies_to` semantics on
    // the single-spawn path.
    return { type: "advance" };
  }

  return { type: "shuttle-batch", spawns };
}

// Read the per-stage fanout iteration counter off the driver scratch
// snapshot. Absent / non-numeric → 0 (first entry).
function readFanoutIterCount(state: PipelineState, key: string): number {
  const raw = state.driver.scratch[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

// Persist the incremented counter into driver_state.scratch (read-modify-
// write over the loaded snapshot, single-writer under this tx) AND mirror it
// onto the in-memory snapshot so a later read in the same pass agrees.
async function bumpFanoutIterCount(
  tx: Transaction,
  state: PipelineState,
  key: string,
  next: number,
): Promise<void> {
  const merged = { ...state.driver.scratch, [key]: next };
  await tx.exec("UPDATE driver_state SET scratch = ? WHERE id = 1", [
    JSON.stringify(merged),
  ]);
  state.driver.scratch = merged;
}

// Map an exhausted fanout budget to a StageResult. `audit-only` proceeds
// without re-spawning (findings from the last round stay open for the gate
// to weigh — the bump-to-cap counter on `driver_state.scratch` is the
// durable record that the loop stopped here); `human` halts for operator
// intervention (a fanout carries no gate schema, so there is no ask-user
// form — the halt is the honest surface); `abandon` completes the task
// rejected.
function fanoutExhaustionResult(
  stage: FanoutStage,
  budget: AttemptBudget,
  count: number,
  cap: number,
  state: PipelineState,
): StageResult {
  const detail = `fanout '${stage.name}' exhausted its iteration budget (count=${count}, cap=${cap})`;
  switch (budget.on_exhaustion) {
    case "audit-only":
      return { type: "advance" };
    case "human":
      return {
        type: "halt",
        directive: {
          code: "FANOUT_ITERATION_BUDGET_EXHAUSTED",
          message: detail,
          recovery_options: [],
        },
      };
    case "abandon":
      return {
        type: "complete",
        directive: {
          task_id: state.task_id,
          verdict: "rejected",
          summary: detail,
        },
      };
    default: {
      const _exhaustive: never = budget.on_exhaustion;
      return _exhaustive;
    }
  }
}
