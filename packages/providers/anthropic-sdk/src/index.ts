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
} from "@loomfsm/kernel";

import { splitForCache, type CacheShapedPayload } from "./cache-control.js";

const DEFAULT_MAX_TOKENS = 4096;

// Throw a max_tokens-truncation signal WITHOUT importing the kernel's
// `KernelError` (which transitively pulls `node:sqlite` and would break this
// provider's lean, sqlite-free import). The driver's provider-executor reads
// this `code` and re-throws it as the surfaceable EXECUTOR_OUTPUT_TRUNCATED.
function throwTruncated(message: string): never {
  const err = new Error(message);
  (err as { code?: string }).code = "EXECUTOR_OUTPUT_TRUNCATED";
  throw err;
}

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
  // "max_tokens" here means the model was CUT OFF at the output cap — the result
  // is a truncated fragment, not a finished answer. Surfaced so the provider can
  // fail loudly rather than return a half-response as success.
  stop_reason?: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    // Cache-READ (a hit on a previously-written prefix).
    cache_read_input_tokens?: number | null;
    // Cache-CREATION (writing the prefix into the cache) — a distinct, premium
    // line item the cost roll-up must not ignore.
    cache_creation_input_tokens?: number | null;
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
      honors_mcp_whitelist: true,
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
      // A response cut off at the output cap is a TRUNCATED fragment, not a
      // finished answer — returning it as success feeds a half-written
      // implementation / review into the next stage. Fail loudly instead so the
      // loop surfaces it (and the operator can raise max_tokens). Re-running with
      // the same cap truncates identically, so the loop will not fast-retry it.
      if (response.stop_reason === "max_tokens") {
        throwTruncated(
          `anthropic-sdk output was truncated at max_tokens (${maxTokens}) — the result is ` +
            `incomplete; raise max_tokens (req.extras.max_tokens) and retry`,
        );
      }
      const output = extractOutput(response.content);
      const cached = response.usage.cache_read_input_tokens ?? 0;
      const cacheWrite = response.usage.cache_creation_input_tokens ?? 0;
      const tokens: { in: number; out: number; cached?: number } = {
        in: response.usage.input_tokens,
        out: response.usage.output_tokens,
      };
      // Omit cached when zero so downstream roll-ups can distinguish
      // "this spawn hit cache for N tokens" from "this spawn did not
      // hit cache at all".
      if (cached > 0) tokens.cached = cached;
      const result: ProviderResult = { type: "result", output, tokens };
      // Cache-WRITE tokens ride out-of-band (the kernel `tokens` shape models
      // only cache-READ): the driver's provider-executor reads it the same way
      // it reads OpenRouter's `cost_usd`. Omitted when zero (no cache write).
      if (cacheWrite > 0) (result as { cache_write?: number }).cache_write = cacheWrite;
      return result;
    },
  };
}

// Build a provider from EITHER an injected client (tests / custom wiring) or an
// API key (the headless dispatch path, which resolves the key from loom's
// secrets and constructs the client here so the CLI never imports the SDK). The
// client is constructed lazily on first spawn so import stays network-free.
export function createAnthropicSdkProvider(opts: {
  client?: AnthropicSdkClientLike;
  apiKey?: string;
}): LLMProvider {
  if (opts.client !== undefined) {
    const client = opts.client;
    return buildProvider(() => client);
  }
  const apiKey = opts.apiKey;
  if (apiKey === undefined || apiKey === "") {
    throw new Error("createAnthropicSdkProvider requires an apiKey or a client");
  }
  let cached: AnthropicSdkClientLike | undefined;
  return buildProvider(() => {
    if (cached === undefined) {
      cached = new Anthropic({ apiKey }) as unknown as AnthropicSdkClientLike;
    }
    return cached;
  });
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
