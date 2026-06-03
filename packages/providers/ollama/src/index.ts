// Local-model LLM provider.
//
// spawn() calls chat() on the underlying ollama client and returns
// {type:"result", output, tokens:{in, out}}. A few architectural
// choices worth flagging:
//
//   - idempotent_spawn: false. Ollama has no native idempotency
//     surface — there is no header or argument the client can carry
//     that the local server uses to dedupe identical retries. Passing
//     req.agent_run_id as a side-channel would be a no-op, so the
//     capability declaration tells the kernel that retries on this
//     provider are NOT auto-dedupable and the surrounding
//     orchestration logic must compensate (e.g. by aborting the prior
//     in-flight call rather than letting a second one bill twice).
//
//   - tokens.cached is intentionally omitted (absent, not zero) from
//     every result envelope. Ollama runs locally, has no token-cache
//     pricing surface, and reporting a zero would lie about
//     measurement rather than value. Downstream roll-ups treat absent
//     vs. zero as the signal "this provider does not participate in
//     caching" — keeping that distinction honest matters for cost
//     reports that aggregate across providers.
//
//   - Response shape differs from OpenAI-compatible APIs: a flat
//     message.content (no choices[] wrapper), and token counters
//     named prompt_eval_count / eval_count rather than
//     prompt_tokens / completion_tokens. The provider translates at
//     the boundary so callers receive the same {output, tokens}
//     surface regardless of upstream vendor.
//
//   - The default singleton lazily constructs the real ollama client
//     on first spawn(). Module import never touches the network; tests
//     and bundle-loaders that import the package without a running
//     Ollama instance do not pay the constructor cost. OLLAMA_HOST is
//     honored with default http://localhost:11434.

import { Ollama } from "ollama";

import type {
  LLMProvider,
  ProviderResult,
  ProviderSpawnRequest,
} from "@loomfsm/kernel";

const DEFAULT_NUM_PREDICT = 4096;
const DEFAULT_OLLAMA_HOST = "http://localhost:11434";

export type OllamaChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string };

export interface OllamaChatOptions {
  num_predict?: number;
}

export interface OllamaChatArgs {
  model: string;
  messages: OllamaChatMessage[];
  options?: OllamaChatOptions;
}

export interface OllamaChatResponse {
  message: { role?: string; content?: string | null };
  eval_count?: number;
  prompt_eval_count?: number;
  done?: boolean;
}

export interface OllamaClientLike {
  chat(args: OllamaChatArgs): Promise<OllamaChatResponse>;
}

function extractMaxTokens(extras: Record<string, unknown> | undefined): number {
  const candidate = extras?.["max_tokens"];
  return typeof candidate === "number" &&
    Number.isFinite(candidate) &&
    candidate > 0
    ? candidate
    : DEFAULT_NUM_PREDICT;
}

function buildMessages(req: ProviderSpawnRequest): OllamaChatMessage[] {
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

function buildProvider(getClient: () => OllamaClientLike): LLMProvider {
  return {
    name: "ollama",
    capabilities: {
      execution: "async",
      idempotent_spawn: false,
      reports_usage: true,
      features: [],
      models: [],
      honors_mcp_whitelist: true,
    },
    agent_tools: [],
    async spawn(req: ProviderSpawnRequest): Promise<ProviderResult> {
      const args: OllamaChatArgs = {
        model: req.model,
        messages: buildMessages(req),
        options: { num_predict: extractMaxTokens(req.extras) },
      };
      const client = getClient();
      const response = await client.chat(args);
      const output = response.message.content ?? "";
      const tokens: { in: number; out: number } = {
        in: response.prompt_eval_count ?? 0,
        out: response.eval_count ?? 0,
      };
      return { type: "result", output, tokens };
    },
  };
}

// Build a provider from EITHER an injected client (tests / custom wiring) or a
// base URL / host (the headless dispatch path). With neither, the host defaults
// to OLLAMA_HOST or localhost. The client is constructed lazily on first spawn
// so import stays network-free and the CLI never imports the SDK.
export function createOllamaProvider(opts: {
  client?: OllamaClientLike;
  baseURL?: string;
}): LLMProvider {
  if (opts.client !== undefined) {
    const client = opts.client;
    return buildProvider(() => client);
  }
  const host = opts.baseURL ?? process.env["OLLAMA_HOST"] ?? DEFAULT_OLLAMA_HOST;
  let cached: OllamaClientLike | undefined;
  return buildProvider(() => {
    if (cached === undefined) {
      cached = new Ollama({ host }) as unknown as OllamaClientLike;
    }
    return cached;
  });
}

let lazyDefaultClient: OllamaClientLike | undefined;
function getLazyDefaultClient(): OllamaClientLike {
  if (lazyDefaultClient !== undefined) return lazyDefaultClient;
  const host = process.env["OLLAMA_HOST"] ?? DEFAULT_OLLAMA_HOST;
  const real = new Ollama({ host });
  lazyDefaultClient = real as unknown as OllamaClientLike;
  return lazyDefaultClient;
}

export const ollamaProvider: LLMProvider =
  buildProvider(getLazyDefaultClient);
