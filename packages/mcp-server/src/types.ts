// Local envelopes returned by the read-only tools.
//
// Defined here rather than in a shared transport-types package so the
// read-only surface stays self-contained; when the mutating tools land
// and need to emit a wire-shared response shape, that work extracts a
// transport-types package and shifts these or their richer siblings
// into it.

import type {
  ContinueTaskInput,
  ExtensionKind,
  ExtensionManifest,
  PipelineStateView,
  StackInfo,
} from "@loom/kernel";
import type { SpawnRequest, TransportResponse } from "@loom/transport-types";

export type { PipelineStateView };

// Re-exported for tool authors that want the wire shape without a second
// import — the mutating handlers return these inside their envelopes.
export type { ContinueTaskInput, SpawnRequest, TransportResponse };

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
// pipeline_run_task
// ---------------------------------------------------------------------

export interface RunTaskInput {
  project_dir: string;
  task: string;
  client_idempotency_uuid: string;
  policy_preset?: string;
  gate_policies?: Record<string, string>;
  complexity_hint?: "simple" | "medium" | "complex";
  tests_mode_hint?: "tdd" | "regression-only";
  stack?: StackInfo;
  owner_id?: string;
  // Opaque, unverified caller string — captured in audit only (see
  // pipeline_meta). Never an identity claim.
  client_identifier_unverified?: string;
}

// The happy-path envelope wraps the shaped wire response plus the task
// identity. `task_id` / `driver_state_id` are present on success and on
// replay; a refusal (error-shaped `response`) omits them. `warnings`
// surfaces `parseTaskArgs` notes so MCP clients can render them — the
// MVP wire response carries no warnings field, so the wrapper is a
// tool-specific envelope, not a generic response extension.
export interface RunTaskResponse {
  response: TransportResponse;
  task_id?: string;
  driver_state_id?: string;
  warnings?: string[];
}

// ---------------------------------------------------------------------
// pipeline_continue_task
// ---------------------------------------------------------------------

export interface ContinueTaskRequestInput {
  project_dir: string;
  driver_state_id: string;
  input: ContinueTaskInput;
  client_identifier_unverified?: string;
}

export interface ContinueTaskResponse {
  response: TransportResponse;
}

// ---------------------------------------------------------------------
// Tool handler primitive — same shape used in the server's `tools` map.
// Tests construct a handler and call it directly, bypassing MCP wire
// framing; the SDK's request dispatcher wraps the same callable on the
// stdio path.
// ---------------------------------------------------------------------

export type ToolHandler<I, O> = (input: I) => Promise<O>;
