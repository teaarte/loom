// Direct-API LLM provider.
//
// spawn() invokes messages.create on the underlying client and returns
// {type:"result", output, tokens}. Two architectural choices worth
// flagging:
//
//   - cache_control is stamped on the LAST system block only (see
//     ./cache-control.ts). Multiple markers fragment the cache prefix
//     into uncacheable chunks; one marker means "cache the whole
//     system prefix", which is the entire point of declaring
//     features: ["prompt_caching"].
//
//   - idempotencyKey is wired to req.agent_run_id. The kernel allocates
//     agent_run_id once per logical spawn and replays it verbatim on
//     transport-level retries — passing it as the API idempotency token
//     means the same logical spawn never re-bills under reconnect /
//     resume, which is the contract reports_usage: true demands.

import Anthropic from "@anthropic-ai/sdk";

import type {
  LLMProvider,
  ProviderResult,
  ProviderSpawnRequest,
} from "@loom/kernel";

import { splitForCache, type CacheShapedPayload } from "./cache-control.js";

const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicMessageCreateArgs {
  model: string;
  max_tokens: number;
  system?: CacheShapedPayload["system"];
  messages: CacheShapedPayload["messages"];
}

export interface AnthropicContentBlock {
  type: string;
  text?: string;
}

export interface AnthropicMessageResponse {
  content: AnthropicContentBlock[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
  };
}

export interface AnthropicMessageCreateOptions {
  idempotencyKey?: string;
}

export interface AnthropicSdkClientLike {
  messages: {
    create(
      args: AnthropicMessageCreateArgs,
      options?: AnthropicMessageCreateOptions,
    ): Promise<AnthropicMessageResponse>;
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

function extractOutput(content: AnthropicContentBlock[]): string {
  let out = "";
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      out += block.text;
    }
  }
  return out;
}

function buildProvider(getClient: () => AnthropicSdkClientLike): LLMProvider {
  return {
    name: "anthropic-sdk",
    capabilities: {
      execution: "async",
      idempotent_spawn: true,
      reports_usage: true,
      features: ["prompt_caching"],
      models: [],
      // honors_mcp_whitelist: true — wire when the loader contract grows the field.
    },
    agent_tools: [],
    async spawn(req: ProviderSpawnRequest): Promise<ProviderResult> {
      const payload = splitForCache(req);
      const maxTokens = extractMaxTokens(req.extras);
      const args: AnthropicMessageCreateArgs = {
        model: req.model,
        max_tokens: maxTokens,
        messages: payload.messages,
      };
      if (payload.system !== undefined) args.system = payload.system;
      const client = getClient();
      const response = await client.messages.create(args, {
        idempotencyKey: req.agent_run_id,
      });
      const output = extractOutput(response.content);
      const cached = response.usage.cache_read_input_tokens ?? 0;
      const tokens: { in: number; out: number; cached?: number } = {
        in: response.usage.input_tokens,
        out: response.usage.output_tokens,
      };
      // Omit cached when zero so downstream roll-ups can distinguish
      // "this spawn hit cache for N tokens" from "this spawn did not
      // hit cache at all".
      if (cached > 0) tokens.cached = cached;
      return { type: "result", output, tokens };
    },
  };
}

export function createAnthropicSdkProvider(opts: {
  client: AnthropicSdkClientLike;
}): LLMProvider {
  return buildProvider(() => opts.client);
}

let lazyDefaultClient: AnthropicSdkClientLike | undefined;
function getLazyDefaultClient(): AnthropicSdkClientLike {
  if (lazyDefaultClient !== undefined) return lazyDefaultClient;
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (apiKey === undefined || apiKey === "") {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  const real = new Anthropic({ apiKey });
  lazyDefaultClient = real as unknown as AnthropicSdkClientLike;
  return lazyDefaultClient;
}

export const anthropicSdkProvider: LLMProvider =
  buildProvider(getLazyDefaultClient);
