// ToolDefinition — pipeline-implemented tools that a provider may
// supply to agents (an SDK-backed API provider exposing a tool-calling
// surface, a local-model runner, etc.). A shuttle-style provider that
// drives an external agent with its own tool inventory does not pass
// ToolDefinition through.

import type { SensitivePathRules } from "../sandbox/resolve-safe-path.js";
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
  // Path-discipline ruleset the file tools consult. The substrate's own
  // floor is domain-neutral; the active bundle contributes ecosystem
  // patterns (a code bundle adds `.npmrc`, `~/.kube`, …). The merged set
  // is bound here ONCE when the per-task tool context is assembled, so
  // every tool call inherits the same blocklist without the catalog
  // having to know which bundle is active. Omitted → the tool falls back
  // to the bare kernel floor (fail-safe: protection exists with zero
  // bundle rules loaded).
  sensitive_path_rules?: SensitivePathRules;
}

export type ToolResult =
  | { content: string; cost_estimate_tokens?: number }
  | { error: string };
