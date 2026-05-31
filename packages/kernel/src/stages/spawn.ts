// SpawnStage interpreter — phase-1 of the three-phase spawn pattern.
//
// Phase 1 (this function) runs inside the stage transaction:
//   - Resolve the agent from the registry; refuse with
//     AGENT_NOT_REGISTERED if it isn't there (the loader normally
//     catches this earlier; defense-in-depth at the interpreter).
//   - Honor Agent.applies_to — predicate returning `false` advances
//     past the stage without launching anything.
//   - SpawnGuard refuses duplicate spawns inside the active duplicate-
//     window (tx.now-based comparison; replay-deterministic).
//   - `begin_spawn` inserts the `pending_agents` row inside the same
//     tx; the row carries `started_at = tx.now`.
//   - Build a `ProviderShuttleIntent` and surface it as `StageResult
//     .shuttle`. The kernel collapses this into a `KernelDirective`;
//     the transport adapter (or the in-process async-provider path)
//     handles provider invocation OUT OF this transaction.
//
// Phase 2 (provider call) and Phase 3 (deliverAgentResult) live
// elsewhere — the kernel here is only responsible for "did we hand
// the request to the host correctly". The pending_agents row plus
// the provider-call ledger entry (written by the transport adapter)
// closes the wire-emit crash window described in the FSM specs.

import { getKernelTx } from "../fsm.js";
import { spawnGuard } from "../guards.js";
import { buildPrompt } from "../prompt-renderer.js";
import type { StageContext } from "../types/context.js";
import type { SpawnStage, StageResult } from "../types/plugins.js";
import type { ProviderShuttleIntent } from "../types/provider.js";
import type { PipelineState } from "../types/state.js";

export async function interpretSpawn(
  stage: SpawnStage,
  state: PipelineState,
  ctx: StageContext,
): Promise<StageResult> {
  const agent = ctx.registry.agents.get(stage.agent);
  if (!agent) {
    return {
      type: "halt",
      directive: {
        code: "AGENT_NOT_REGISTERED",
        message: `SpawnStage '${stage.name}' references unregistered agent '${stage.agent}'`,
        recovery_options: [],
      },
    };
  }

  if (agent.applies_to && !agent.applies_to(ctx.state)) {
    return { type: "advance" };
  }

  await spawnGuard(getKernelTx(ctx), stage.agent, stage.phase);

  const agent_run_id = await ctx.begin_spawn(stage.agent, stage.phase);
  // Provider AND model come from the same route (resolved over agent +
  // phase), so a routing config can send this agent to a specific provider
  // and the directive carries the matching model. No route → the bundle
  // default provider and the agent's own model (then the generic fallback).
  const provider = ctx.registry.providers.resolve(stage.agent, state, stage.phase);
  const model =
    ctx.registry.providers.resolveModel?.(stage.agent, state, stage.phase) ??
    agent.default_model ??
    "default";

  const extras: Record<string, unknown> = { provider: provider.name };
  if (agent.template_path.length > 0) {
    extras["template_path"] = agent.template_path;
  }

  const intent: ProviderShuttleIntent = {
    agent: stage.agent,
    agent_run_id,
    phase: stage.phase,
    model,
    prompt: buildPrompt(state, agent, ctx.registry),
    extras,
  };
  if (agent.system_prompt !== undefined) {
    intent.system_prompt = agent.system_prompt;
  }
  if (agent.mcp_tools !== undefined) {
    intent.mcp_tools_available = agent.mcp_tools;
  }

  return { type: "shuttle", intent };
}
