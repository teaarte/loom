// pipeline_get_spawn_prompt — fetch one fanout agent's prompt by reference.
//
// A wide fanout directive lists each agent + its model/extras but omits the
// bulky prompt (see the transport adapter's `prompts_by_reference` path):
// inlining N full prompts in one envelope blows past the MCP client's
// inline-response cap. The host calls this once per agent_run_id to fetch
// the prompt just before dispatching that spawn.
//
// The prompt is RE-DERIVED, not stored: `buildPrompt(state, agent, registry)`
// is a pure function of the loaded state, so reading it back here reproduces
// exactly what the fanout interpreter rendered. Nothing was persisted at
// fanout time, so the kernel stays free of a prompt-blob column. The pending
// agent row (written when the fanout launched) supplies the agent name +
// model the directive carried.
//
// Read-only: one `withReadTransaction` snapshot, no state mutation.

import {
  assertProjectDirAllowed,
  buildPrompt,
  loadState,
  withReadTransaction,
  KernelError,
  type Registry,
  type Transaction,
} from "@loomfsm/kernel";

import type {
  GetSpawnPromptInput,
  GetSpawnPromptResponse,
  ToolHandler,
} from "../types.js";

export interface GetSpawnPromptDeps {
  resolveRegistry?: (projectDir: string) => Promise<Registry> | Registry;
  allowlistPath?: string;
}

export function createGetSpawnPromptTool(
  deps: GetSpawnPromptDeps = {},
): ToolHandler<GetSpawnPromptInput, GetSpawnPromptResponse> {
  return async (input) => {
    // 1. Project-dir allowlist.
    try {
      await assertProjectDirAllowed(
        input.project_dir,
        deps.allowlistPath !== undefined ? { allowlistPath: deps.allowlistPath } : undefined,
      );
    } catch (err) {
      return refusal(err);
    }

    if (deps.resolveRegistry === undefined) {
      return errorResponse(
        "REGISTRY_UNAVAILABLE",
        "no registry resolver is wired for the active-task path",
      );
    }
    const registry = await deps.resolveRegistry(input.project_dir);

    try {
      return await withReadTransaction(input.project_dir, async (tx) => {
        const pending = await readPendingAgent(tx, input.agent_run_id);
        if (pending === null) {
          return errorResponse(
            "PENDING_AGENT_NOT_FOUND",
            `no pending_agents row for agent_run_id '${input.agent_run_id}'`,
          );
        }
        const agent = registry.agents.get(pending.agent);
        if (agent === undefined) {
          return errorResponse(
            "AGENT_NOT_REGISTERED",
            `agent '${pending.agent}' is not in the active registry`,
          );
        }
        const state = await loadState(tx);
        const prompt = buildPrompt(state, agent, registry);
        return { prompt, agent: pending.agent, model: pending.model };
      });
    } catch (err) {
      return refusal(err);
    }
  };
}

async function readPendingAgent(
  tx: Transaction,
  agentRunId: string,
): Promise<{ agent: string; model: string | null } | null> {
  const row = await tx.queryRow<{ agent: unknown; model: unknown }>(
    "SELECT agent, model FROM pending_agents WHERE agent_run_id = ?",
    [agentRunId],
  );
  if (row === null) return null;
  return {
    agent: String(row.agent),
    model: row.model === null ? null : String(row.model),
  };
}

function refusal(err: unknown): GetSpawnPromptResponse {
  if (err instanceof KernelError) {
    return errorResponse(err.code, err.message);
  }
  throw err;
}

function errorResponse(code: string, message: string): GetSpawnPromptResponse {
  return { prompt: null, agent: null, model: null, error: { code, message } };
}
