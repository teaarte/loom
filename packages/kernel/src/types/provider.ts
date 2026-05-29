// LLMProvider runtime shapes.
//
// What an `LLMProvider.spawn()` call returns. Provider-layer types; the
// transport adapter is the only consumer that knows how to shape a
// `ProviderShuttleIntent` into its own wire envelope. Provider code
// never touches transport types — that is the seam.

import type { ModelName, Phase } from "./row-types.js";
import type { ToolDefinition } from "./tool.js";

export type ProviderResult =
  | {
      type: "result";
      output: string;
      parsed_json?: Record<string, unknown>;
      tool_calls?: ToolCall[];
      tokens?: { in: number; out: number; cached?: number };
    }
  | {
      type: "stream";
      stream: AsyncIterable<StreamEvent>;
      finalize(): Promise<{
        output: string;
        parsed_json?: Record<string, unknown>;
        tool_calls?: ToolCall[];
        tokens?: { in: number; out: number; cached?: number };
      }>;
    }
  | {
      type: "shuttle";
      intent: ProviderShuttleIntent;
    };

// Neutral tool-call shape. Providers translate vendor-specific
// envelopes (Anthropic's `tool_use`, OpenAI's `tool_calls[].function`,
// Google's `functionCall`) into this; kernel and bundles never touch
// vendor types.
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// Provider-emitted shuttle descriptor. Transport-neutral — the active
// transport adapter turns this into its own wire-envelope spawn intent
// (an MCP/stdio spawn response, an SSE event for daemon/HTTP, etc.).
export interface ProviderShuttleIntent {
  agent: string;
  agent_run_id: string;
  phase: Phase;
  model: ModelName;
  system_prompt?: string;
  prompt: string;
  mcp_tools_available?: string[];
  extras?: Record<string, unknown>;
}

// Provider-layer spawn request. Distinct from the adapter-set
// wire-envelope spawn descriptor; the transport adapter is the only
// consumer that shapes one into the other.
export interface ProviderSpawnRequest {
  agent: string;
  agent_run_id: string;
  phase: Phase;
  model: ModelName;
  system_prompt?: string;
  prompt: string;
  mcp_tools_available?: string[];
  extras?: Record<string, unknown>;
}

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call-delta"; id: string; name?: string; input_delta?: string }
  | { type: "usage"; tokens: { in: number; out: number; cached?: number } }
  | { type: "error"; message: string };

// Canonical LLMProvider contract — defined in full here, co-located
// with its runtime result/intent shapes above (it references them
// directly) rather than alongside the other contracts in `plugins.ts`,
// so the provider neighbourhood's imports stay flat.
import type { PluginMeta } from "./plugins.js";

export interface LLMProvider extends PluginMeta {
  capabilities: {
    execution: "async" | "shuttle";
    idempotent_spawn: boolean;
    reports_usage: boolean;
    streaming_resume?: "from_state" | "restart" | "fail";
    features?: string[];
    models?: string[];
    // Provider attests it honors the bundle's MCP tool whitelist when
    // spawning agents. Optional so providers that have not yet wired
    // the gate can still type-check; the loader gains a refusal when a
    // provider declaring `agent_tools` that contains a Bash tool ships
    // without setting this to `true`.
    honors_mcp_whitelist?: boolean;
  };
  spawn(request: ProviderSpawnRequest): Promise<ProviderResult>;
  agent_tools?: ToolDefinition[];
}
