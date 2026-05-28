// Local envelopes returned by the read-only tools.
//
// Defined here rather than in a shared transport-types package so the
// read-only surface stays self-contained; when the mutating tools land
// and need to emit a wire-shared response shape, that work extracts a
// transport-types package and shifts these or their richer siblings
// into it.

import type { ExtensionKind, ExtensionManifest, PipelineStateView } from "@loom/kernel";

export type { PipelineStateView };

// ---------------------------------------------------------------------
// pipeline_meta
// ---------------------------------------------------------------------

export interface ClientCapabilities {
  honors_shuttle?: boolean;
  supports_sse?: boolean;
  supports_streaming?: boolean;
}

export interface MetaInput {
  client_identifier_unverified?: string;
  client_capabilities?: ClientCapabilities;
}

export interface MetaTransports {
  active: string;
  available: string[];
}

export interface MetaProviders {
  enabled: string[];
  active_default: string;
  compatible_with_client: string[];
}

export interface MetaBundle {
  name: string;
  version: string;
}

export interface MetaSandbox {
  kind: string;
}

export interface PipelineMetaResponse {
  protocol_version: string;
  plugin_api_version: string;
  kernel_version: string;
  client_identifier_unverified: string;
  flag_vocabulary: string[];
  transports: MetaTransports;
  providers: MetaProviders;
  bundles_available: MetaBundle[];
  sandbox: MetaSandbox;
}

// ---------------------------------------------------------------------
// pipeline_state_get
// ---------------------------------------------------------------------

export type StateGetFormat = "summary" | "json" | "jsonl" | "pretty-table";

export interface StateGetInput {
  project_dir: string;
  format?: StateGetFormat;
  table?: string;
  since?: string;
  limit?: number;
}

// ---------------------------------------------------------------------
// pipeline_extensions_list
// ---------------------------------------------------------------------

export type ExtensionStatus = "enabled" | "disabled" | "failed";

export interface ExtensionsListInput {
  project_dir: string;
  kind?: ExtensionKind;
  status?: ExtensionStatus;
  include_manifest?: boolean;
}

export interface ExtensionsListEntry {
  id: string;
  kind: ExtensionKind;
  name: string;
  publisher: string;
  version: string;
  status: ExtensionStatus;
  installed_at: string;
  updated_at: string;
  failure_reason?: string;
  manifest?: ExtensionManifest;
}

export interface ExtensionsListResponse {
  extensions: ExtensionsListEntry[];
}

// ---------------------------------------------------------------------
// parseTaskArgs return shape
// ---------------------------------------------------------------------

export interface ParsedTaskArgs {
  task: string;
  policy_preset?: string;
  warnings: string[];
}

// ---------------------------------------------------------------------
// Tool handler primitive — same shape used in the server's `tools` map.
// Tests construct a handler and call it directly, bypassing MCP wire
// framing; the SDK's request dispatcher wraps the same callable on the
// stdio path.
// ---------------------------------------------------------------------

export type ToolHandler<I, O> = (input: I) => Promise<O>;
