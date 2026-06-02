// A provider-backed `Executor` — wraps an async `LLMProvider` so the
// headless loop runs spawns in-process instead of round-tripping a host.
//
// Only an `execution: "async"` provider can run headless: a `shuttle`
// provider hands the spawn back to a host to execute, which has no meaning
// when there is no host in the loop, so it is refused. The provider's
// `agent_run_id` is the kernel's REUSED id, threaded straight through.

import { KernelError } from "@loomfsm/kernel";
import type {
  LLMProvider,
  ProviderShuttleIntent,
  ProviderSpawnRequest,
} from "@loomfsm/kernel";

import type { Executor, ExecutorResult } from "./drive.js";

export function createProviderExecutor(provider: LLMProvider): Executor {
  return {
    async execute(spawn: ProviderShuttleIntent): Promise<ExecutorResult> {
      const request: ProviderSpawnRequest = {
        agent: spawn.agent,
        agent_run_id: spawn.agent_run_id,
        phase: spawn.phase,
        model: spawn.model,
        prompt: spawn.prompt,
        ...(spawn.system_prompt !== undefined ? { system_prompt: spawn.system_prompt } : {}),
        ...(spawn.mcp_tools_available !== undefined
          ? { mcp_tools_available: spawn.mcp_tools_available }
          : {}),
        ...(spawn.extras !== undefined ? { extras: spawn.extras } : {}),
      };
      const result = await provider.spawn(request);
      switch (result.type) {
        case "result":
          return { agent_output: result.output };
        case "stream": {
          const final = await result.finalize();
          return { agent_output: final.output };
        }
        case "shuttle":
          throw new KernelError({
            code: "PROVIDER_NOT_HEADLESS",
            message:
              `provider '${provider.name}' is shuttle-only — it hands spawns to a host and ` +
              `cannot run headless; configure an async provider for the headless loop`,
            detail: { provider: provider.name },
          });
        default: {
          const _exhaustive: never = result;
          return _exhaustive;
        }
      }
    },
  };
}
