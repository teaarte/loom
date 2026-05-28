// Unified-router LLM provider.
//
// spawn() calls chat.completions.create on the underlying client and
// returns {type:"result", output, tokens:{in, out}}. Two architectural
// choices worth flagging:
//
//   - idempotencyKey is wired to req.agent_run_id. The kernel allocates
//     agent_run_id once per logical spawn and replays it verbatim on
//     transport-level retries — passing it as the API idempotency token
//     means the same logical spawn never re-bills under reconnect /
//     resume, which is the contract reports_usage: true demands.
//
//   - The default singleton hard-codes
//     baseURL: "https://openrouter.ai/api/v1". Callers pick vendor +
//     model via the model string (e.g. "anthropic/claude-opus-4");
//     routing lives in the unified-router service, not in this provider.
//     Custom base URLs are an explicit DI concern — pass a fully-
//     constructed client to createOpenRouterProvider({client}).

import OpenAI from "openai";

import type {
  LLMProvider,
  ProviderResult,
  ProviderSpawnRequest,
} from "@loom/kernel";

const DEFAULT_MAX_TOKENS = 4096;
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export type OpenRouterChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string };

export interface OpenRouterChatCompletionArgs {
  model: string;
  max_tokens: number;
  messages: OpenRouterChatMessage[];
}

export interface OpenRouterChatCompletionResponseChoice {
  message?: { role?: string; content?: string | null };
}

export interface OpenRouterChatCompletionResponse {
  choices: OpenRouterChatCompletionResponseChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface OpenRouterChatCompletionOptions {
  idempotencyKey?: string;
}

export interface OpenRouterClientLike {
  chat: {
    completions: {
      create(
        args: OpenRouterChatCompletionArgs,
        options?: OpenRouterChatCompletionOptions,
      ): Promise<OpenRouterChatCompletionResponse>;
    };
  };
}

function extractMaxTokens(extras: Record<string, unknown> | undefined): number {
  const candidate = extras?.["max_tokens"];
  return typeof candidate === "number" &&
    Number.isFinite(candidate) &&
    candidate > 0
    ? candidate
    : DEFAULT_MAX_TOKENS;
}

function buildMessages(req: ProviderSpawnRequest): OpenRouterChatMessage[] {
  if (
    typeof req.system_prompt === "string" &&
    req.system_prompt.length > 0
  ) {
    return [
      { role: "system", content: req.system_prompt },
      { role: "user", content: req.prompt },
    ];
  }
  return [{ role: "user", content: req.prompt }];
}

function buildProvider(getClient: () => OpenRouterClientLike): LLMProvider {
  return {
    name: "openrouter",
    capabilities: {
      execution: "async",
      idempotent_spawn: true,
      reports_usage: true,
      features: [],
      models: [],
      // honors_mcp_whitelist: true — wire when the loader contract grows the field.
    },
    agent_tools: [],
    async spawn(req: ProviderSpawnRequest): Promise<ProviderResult> {
      const args: OpenRouterChatCompletionArgs = {
        model: req.model,
        max_tokens: extractMaxTokens(req.extras),
        messages: buildMessages(req),
      };
      const client = getClient();
      const response = await client.chat.completions.create(args, {
        idempotencyKey: req.agent_run_id,
      });
      const output = response.choices[0]?.message?.content ?? "";
      const usage = response.usage;
      const tokens: { in: number; out: number } = {
        in: usage?.prompt_tokens ?? 0,
        out: usage?.completion_tokens ?? 0,
      };
      // tokens.cached is intentionally omitted (absent, not zero) — the
      // unified-router caching surface is per-route and opt-in via API
      // headers, so this provider cannot attribute cached tokens to a
      // single result envelope. Downstream roll-ups treat absent vs.
      // zero as the signal "this provider does not surface caching".
      return { type: "result", output, tokens };
    },
  };
}

export function createOpenRouterProvider(opts: {
  client: OpenRouterClientLike;
}): LLMProvider {
  return buildProvider(() => opts.client);
}

let lazyDefaultClient: OpenRouterClientLike | undefined;
function getLazyDefaultClient(): OpenRouterClientLike {
  if (lazyDefaultClient !== undefined) return lazyDefaultClient;
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (apiKey === undefined || apiKey === "") {
    throw new Error("OPENROUTER_API_KEY is not set");
  }
  const real = new OpenAI({ apiKey, baseURL: OPENROUTER_BASE_URL });
  lazyDefaultClient = real as unknown as OpenRouterClientLike;
  return lazyDefaultClient;
}

export const openRouterProvider: LLMProvider =
  buildProvider(getLazyDefaultClient);
