// A provider-backed `Executor` — wraps an async `LLMProvider` so the
// headless loop runs spawns in-process instead of round-tripping a host.
//
// Only an `execution: "async"` provider can run headless: a `shuttle`
// provider hands the spawn back to a host to execute, which has no meaning
// when there is no host in the loop, so it is refused. The provider's
// `agent_run_id` is the kernel's REUSED id, threaded straight through.
//
// This is the PLAIN backend: it makes one model call and returns the text.
// Unlike the sandboxed `claude -p` executor it provisions NO worktree and
// reports NO file delta — a raw model call is a decision-agent's single-shot
// answer, not a file-editing run. The agentic tool-loop a work-agent needs is
// a separate, later seam; this executor stays single-shot by design.

import { KernelError } from "@loomfsm/kernel";
import type {
  LLMProvider,
  ProviderShuttleIntent,
  ProviderSpawnRequest,
} from "@loomfsm/kernel";

import type { Executor, ExecutorResult, SpawnUsage } from "./drive.js";

// Classify a provider-thrown spawn error as a sustained rate-limit / quota
// condition — the signal the supervisor's wait disposition keys on (wait, do
// NOT retry-and-escalate). Each async backend throws its OWN error shape (an
// OpenAI/Anthropic SDK error carries a numeric `status`; the `ollama` client
// throws a `ResponseError` carrying `status_code` + an `error` message), so the
// matcher is INJECTABLE per backend — exactly like the `claude -p` capture
// seam's `RateLimitDetector`, never a single vendor assumption baked in here.
// Default (no detector) → no thrown error is treated as a rate-limit.
export type ProviderErrorRateLimitDetector = (err: unknown) => boolean;

export interface ProviderExecutorOptions {
  // Recognise a sustained rate-limit in a thrown spawn error → the loop
  // surfaces EXECUTOR_RATE_LIMITED (the supervisor waits) instead of the
  // generic EXECUTOR_FAILED. Injectable per backend; omitted → no error is a
  // rate-limit.
  detectRateLimit?: ProviderErrorRateLimitDetector;
  // Sink for per-spawn usage (the tokens a `reports_usage` provider returns).
  // Surfaced for audit/observability — the loop does not persist it. Omitted →
  // usage is dropped.
  onUsage?: (usage: SpawnUsage) => void;
}

// A provider MAY attach a backend-computed dollar cost to its spawn result as an
// out-of-band `cost_usd` — the kernel `ProviderResult` does NOT model dollars
// (it is vendor-neutral and tracks tokens), so OpenRouter's generation cost (and
// any future paid backend's) rides alongside, read here defensively and surfaced
// only on the driver's observability `SpawnUsage`. Absent / non-finite → omitted
// (free or non-reporting backends contribute no cost, never a fabricated zero).
function readResultCost(result: unknown): number | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const c = (result as { cost_usd?: unknown }).cost_usd;
  return typeof c === "number" && Number.isFinite(c) ? c : undefined;
}

export function createProviderExecutor(
  provider: LLMProvider,
  opts: ProviderExecutorOptions = {},
): Executor {
  const finish = (
    spawn: ProviderShuttleIntent,
    output: string,
    tokens?: { in: number; out: number; cached?: number },
    cost?: number,
  ): ExecutorResult => {
    const result: ExecutorResult = { agent_output: output };
    if (tokens !== undefined || cost !== undefined) {
      // Stamp the spawn identity so the observability sink shows which agent +
      // model the usage was for (M2), alongside tokens (kernel-native) and the
      // out-of-band backend cost (M5).
      const usage: SpawnUsage = {
        agent: spawn.agent,
        model: spawn.model,
        ...(tokens !== undefined ? { tokens } : {}),
        ...(cost !== undefined ? { cost_usd: cost } : {}),
      };
      result.usage = usage;
      opts.onUsage?.(usage);
    }
    return result;
  };

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
      let result;
      try {
        result = await provider.spawn(request);
      } catch (err) {
        // A recognised rate-limit becomes the surfaceable EXECUTOR_RATE_LIMITED
        // (a wait); every other throw bubbles up as-is and the loop wraps it as
        // the generic EXECUTOR_FAILED (a fast retry).
        if (opts.detectRateLimit?.(err) === true) {
          throw new KernelError({
            code: "EXECUTOR_RATE_LIMITED",
            message: `provider '${provider.name}' hit a rate limit / quota`,
            detail: { provider: provider.name },
          });
        }
        throw err;
      }
      switch (result.type) {
        case "result":
          return finish(spawn, result.output, result.tokens, readResultCost(result));
        case "stream": {
          const final = await result.finalize();
          return finish(spawn, final.output, final.tokens, readResultCost(final));
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
