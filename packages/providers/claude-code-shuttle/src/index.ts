// Shuttle-pattern LLM provider.
//
// Emits a ProviderShuttleIntent on every spawn(). No API call, no
// token usage, no streaming — the host's task-runner executes the
// agent, this package only shapes the kernel's spawn request into a
// transport-neutral shuttle envelope. The conservative capability
// matrix (idempotent_spawn=false, reports_usage=false, no features,
// no model list) reflects that the host owns execution semantics,
// billing, and model selection; the kernel must not assume otherwise.

import type {
  LLMProvider,
  ProviderResult,
  ProviderShuttleIntent,
  ProviderSpawnRequest,
} from "@loom/kernel";

const RUNNER_HINT = "claude-code-task";

export const claudeCodeShuttleProvider: LLMProvider = {
  name: "claude-code-shuttle",
  capabilities: {
    execution: "shuttle",
    idempotent_spawn: false,
    reports_usage: false,
    features: [],
    models: [],
    // honors_mcp_whitelist: true — wire when the loader contract grows the field.
  },
  spawn(req: ProviderSpawnRequest): Promise<ProviderResult> {
    const intent: ProviderShuttleIntent = {
      agent: req.agent,
      agent_run_id: req.agent_run_id,
      phase: req.phase,
      model: req.model,
      prompt: req.prompt,
      // Provider override wins on collision: an inbound runner_hint
      // would let a caller misdirect the host to an incompatible runner.
      extras: { ...(req.extras ?? {}), runner_hint: RUNNER_HINT },
    };
    if (req.system_prompt !== undefined) intent.system_prompt = req.system_prompt;
    if (req.mcp_tools_available !== undefined) {
      intent.mcp_tools_available = req.mcp_tools_available;
    }
    return Promise.resolve({ type: "shuttle", intent });
  },
};
