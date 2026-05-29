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
// pipeline_recover
// ---------------------------------------------------------------------

export type RecoveryChoiceInput =
  | "abandon"
  | "force-close"
  | "retry"
  | "retry-failed"
  | "cancel-pending";

// The marker fields a caller presents on a cross-owner recovery — the
// exact shape `pipeline_issue_cross_owner_marker` returns. Every field
// except `key_id` feeds the HMAC the kernel re-derives to verify it.
export interface BypassMarkerInput {
  issued_at: string;
  expires_at: string;
  reason: string;
  hmac: string;
  key_id: string;
}

export interface RecoverTaskInput {
  project_dir: string;
  driver_state_id: string;
  choice: RecoveryChoiceInput;
  // Required only when choice === "retry-failed".
  agent_run_ids?: string[];
  // Server-issued idempotency key. Omit on the first call (the kernel
  // mints one and returns it); pass it back to replay the cached
  // response; omit it to issue a NEW recovery action.
  recovery_id?: string;
  owner_id?: string;
  // Present only for a cross-owner recovery — the signed, single-use
  // marker an operator minted via pipeline_issue_cross_owner_marker.
  marker?: BypassMarkerInput;
  // Opaque, unverified caller string — audit only.
  client_identifier_unverified?: string;
}

// ---------------------------------------------------------------------
// pipeline_issue_cross_owner_marker
// ---------------------------------------------------------------------

export interface IssueCrossOwnerMarkerInput {
  project_dir: string;
  driver_state_id: string;
  ttl_ms: number;
  client_identifier_unverified?: string;
}

// On success every field is set and `error` is undefined; on a refusal
// (allowlist miss, no signing key) the fields are null and `error`
// carries the typed code. The caller passes the marker fields verbatim
// to pipeline_recover.
export interface IssueCrossOwnerMarkerResponse {
  key_id: string | null;
  hmac: string | null;
  issued_at: string | null;
  expires_at: string | null;
  reason: string | null;
  error?: { code: string; message: string };
}

// The wire response plus the always-present server-issued recovery_id (a
// retry is keyable even when the response is a refusal envelope).
export interface RecoverTaskResponse {
  response: TransportResponse;
  recovery_id: string;
}

// ---------------------------------------------------------------------
// pipeline_backup
// ---------------------------------------------------------------------

export interface BackupInput {
  project_dir: string;
  to: string;
  client_identifier_unverified?: string;
}

// `bytes_written` / `backup_path` are null on a refusal; `error` carries
// the typed code. `ts` is the threaded NowToken on both paths.
export interface BackupResponse {
  bytes_written: number | null;
  ts: string;
  backup_path: string | null;
  error?: { code: string; message: string };
}

// ---------------------------------------------------------------------
// pipeline_restore
// ---------------------------------------------------------------------

export interface RestoreInput {
  project_dir: string;
  from: string;
  format: "sql" | "binary";
  confirm?: boolean;
  client_identifier_unverified?: string;
}

// `restored` is false on a refusal; `error` carries the typed code
// (RESTORE_CONFIRM_REQUIRED / RESTORE_REJECTED / PROJECT_DIR_NOT_ALLOWED).
export interface RestoreResponse {
  restored: boolean;
  ts: string;
  error?: { code: string; message: string };
}

// ---------------------------------------------------------------------
// Tool handler primitive — same shape used in the server's `tools` map.
// Tests construct a handler and call it directly, bypassing MCP wire
// framing; the SDK's request dispatcher wraps the same callable on the
// stdio path.
// ---------------------------------------------------------------------

export type ToolHandler<I, O> = (input: I) => Promise<O>;
