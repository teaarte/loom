// Stage + Hook contexts and the bundle-facing transaction façade.
//
// Bundle plugins never see raw SQLite. `BundleScratchTx` accumulates a
// `BundleOp` buffer; the kernel applies the buffer inside its own
// single transaction. In MVP bundles run in-process and the façade
// still intercepts every write; the worker-thread fence (deferred)
// ships the same buffer across postMessage with no kernel-side
// applier change.

import type { AgentRecord } from "./agent-result.js";
import type { Bundle } from "./bundle.js";
import type { Finding, FindingSeverity, FindingStatus } from "./findings.js";
import type { LLMProvider } from "./provider.js";
import type { ModelName, Phase } from "./row-types.js";
import type { NowToken } from "./now.js";
import type { BundleStateView, PipelineState } from "./state.js";
import type { AuditEntry } from "./transaction.js";

import type { ProviderRegistry, Registry } from "./registry.js";

export interface StageContext {
  registry: Registry;
  // Bundle code mutates kernel-owned tables only through this façade —
  // the raw `Transaction` never crosses a plugin boundary.
  tx: BundleScratchTx;
  bundle: Bundle;
  provider_registry: ProviderRegistry;
  state: BundleStateView;
  now: NowToken;
  begin_spawn(agent: string, phase: Phase, model?: ModelName): Promise<string>;
  resolve_provider(agent: string): LLMProvider;
  audit_extra(payload: Record<string, unknown>): void;
  findings: FindingsAccess;
  audit_query: AuditAccess;
  agents_query: AgentRecordsAccess;
}

// Manifest gates determine which mutators are defined on the instance:
// `state.write.decisions` → `set_decision` available; absence →
// `undefined`. Reads serve a read-only snapshot captured at the start
// of the bundle call (no live cursors, no torn reads).
export interface BundleScratchTx {
  read: {
    pipeline_state(): PipelineState;
    findings(filter?: { phase?: Phase; agent?: string }): Finding[];
    agent_records(filter?: { phase?: Phase; agent?: string }): AgentRecord[];
    audit(filter?: { type?: string; since?: string; limit?: number }): AuditEntry[];
    bundle_table<T = Record<string, unknown>>(table: string, where?: Partial<T>): T[];
  };

  set_decision?(key: string, value: unknown): void;
  record_finding?(f: Finding): void;
  set_bundle_state_field?(path: string, value: unknown): void;
  record_files_modified?(paths: string[]): void;
  record_files_created?(paths: string[]): void;
  upsert_bundle_row?(table: string, row: Record<string, unknown>): void;

  audit(payload: Record<string, unknown>): void;
}

// Operation envelope shipped from worker → kernel main thread. Closed
// union — kernel switch is exhaustive; unknown variant = registry-load
// refusal.
export type BundleOp =
  | { op: "set_decision"; key: string; value: unknown }
  | { op: "record_finding"; finding: Finding }
  | { op: "set_bundle_state_field"; path: string; value: unknown }
  | { op: "record_files_modified"; paths: string[] }
  | { op: "record_files_created"; paths: string[] }
  | { op: "upsert_bundle_row"; table: string; row: Record<string, unknown> }
  | { op: "audit"; payload: Record<string, unknown> }
  | { op: "render_view"; path: string; content: string };

export interface FindingsAccess {
  query(filter: {
    phase?: Phase;
    agent?: string;
    severity?: FindingSeverity[];
    status?: FindingStatus[];
  }): Finding[];
  countBlocking(filter?: { phase?: Phase }): number;
  queryByPhase(phase: Phase): Finding[];
}

export interface AuditAccess {
  recent(filter: { type?: string; since?: string; limit?: number }): AuditEntry[];
}

export interface AgentRecordsAccess {
  query(filter: { phase?: Phase; agent?: string }): AgentRecord[];
}

// Hooks run AFTER the kernel transaction commits and have NO `tx`.
// In-transaction event work is expressed as a StepStage with
// `position: "event"` — the two shapes are disjoint by design.
export interface HookContext {
  registry: Registry;
  bundle: Bundle;
  provider_registry: ProviderRegistry;
  now: NowToken;
  state: BundleStateView;
  stage?: string;
  agent?: string;
  agent_output?: string;
  agent_run_id?: string;
  finding?: Finding;
  // Forms half of the side-effect hook ledger key
  // `side-effect-hook:<hook_name>:<idem_correlation>`. Custom events
  // MUST supply a non-empty string when calling `emit_event`.
  idem_correlation: string;

  emit_event(name: string, payload: Record<string, unknown>): Promise<void>;

  findings: FindingsAccess;
  audit_query: AuditAccess;
  agents_query: AgentRecordsAccess;
}
