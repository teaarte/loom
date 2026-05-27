// ToolDefinition — pipeline-implemented tools that providers may
// supply to agents (anthropic-sdk, openai-sdk, ollama, etc.).
// claude-code-shuttle uses CC's own tool inventory and does not pass
// ToolDefinition through.

import type { Sandbox } from "./plugins.js";

export interface ToolDefinition {
  name: string;
  description: string;
  schema: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
  handler(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  // Verbose tools (Bash, grep, build output) declare this so the
  // kernel compresses ToolResult.content before it reaches the agent.
  // Compression is kernel-side and deterministic.
  output_compression?: OutputCompressionPolicy;
}

export interface OutputCompressionPolicy {
  // "none"            — no compression (default)
  // "truncate-head"   — drop first chars, keep tail (Bash exit status lives at tail)
  // "truncate-tail"   — keep first chars, drop tail (log heads)
  // "deduplicate"     — collapse consecutive duplicates, preserves order
  // "summarize"       — kernel calls a configured summary provider (future)
  strategy: "none" | "truncate-head" | "truncate-tail" | "deduplicate" | "summarize";
  threshold_bytes?: number;
  target_bytes?: number;
  summary_model?: string;
}

export interface ToolContext {
  project_dir: string;
  sandbox: Sandbox;
  audit_emit(payload: Record<string, unknown>): void;
}

export type ToolResult =
  | { content: string; cost_estimate_tokens?: number }
  | { error: string };
