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

import { getKernelTx } from "../fsm.js";
import { spawnGuard } from "../guards.js";
import { buildPrompt } from "../prompt-renderer.js";
import type { StageContext } from "../types/context.js";
import type { FanoutStage, StageResult } from "../types/plugins.js";
import type { ProviderShuttleIntent } from "../types/provider.js";
import type { PipelineState } from "../types/state.js";

export async function interpretFanout(
  stage: FanoutStage,
  state: PipelineState,
  ctx: StageContext,
): Promise<StageResult> {
  if (stage.agents.length === 0) {
    return { type: "advance" };
  }

  const rawTx = getKernelTx(ctx);
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

    const provider = ctx.resolve_provider(agentName);
    const model = agent.default_model ?? "default";

    const extras: Record<string, unknown> = { provider: provider.name };
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
