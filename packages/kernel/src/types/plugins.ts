// Plugin contracts.
//
// `LLMProvider` is the one plugin contract that lives in `provider.ts`
// instead of here — it pulls in `ProviderResult` / `ProviderSpawnRequest`
// directly, so co-locating with those keeps imports flat.
//
// The Stage union is the heart of the FSM execution surface — five
// disjoint kinds (spawn / fanout / gate / step / finalize) cover every
// possible flow step. Loader checks are exhaustive precisely because
// the discriminant set is closed; a new kind requires a new variant
// and a new interpreter, in lockstep.

import type { AttemptBudget, TimeBudget } from "./budget.js";
import type { AgentResult } from "./agent-result.js";
import type { HookContext, StageContext } from "./context.js";
import type { ProviderShuttleIntent } from "./provider.js";
import type { GateRole, Phase } from "./row-types.js";
import type { BundleStateView } from "./state.js";
import type { UserAnswer, UserAnswerSchema } from "./user-answer.js";

export interface PluginMeta {
  name: string;
}

// Agent output classification. Kernel-default set listed below;
// bundles extend via `Bundle.extends_vocab.output_kinds` per the
// kernel-additive enum convention. Runtime validation refuses values
// outside `KernelVocabularies.output_kinds.all`.
export type AgentOutputKind =
  | "reviewer"
  | "validator"
  | "nonreview"
  | "classifier"
  | (string & {});

export interface Agent extends PluginMeta {
  template_path: string;
  output_kind: AgentOutputKind;
  default_model?: string;
  applies_to?: (state: BundleStateView) => boolean;
  relevant_for_change_kinds?: string[];
  mcp_tools?: string[];
  system_prompt?: string;
  context_budget?: {
    soft_threshold_tokens?: number;
    hard_threshold_tokens?: number;
  };
}

// ============================================================================
// Stage discriminated union — every flow step is one of these five
// ============================================================================

export type Stage =
  | SpawnStage
  | FanoutStage
  | GateStage
  | StepStage
  | FinalizeStage;

export type StageKind = Stage["kind"];

// Result returned by every stage interpreter. The kernel collapses
// `shuttle` / `shuttle-batch` into the outgoing `KernelDirective` at
// the FSM-tick boundary; transport adapters never see `StageResult`.
export type StageResult =
  | { type: "advance" }
  | { type: "shuttle"; intent: ProviderShuttleIntent }
  | { type: "shuttle-batch"; spawns: ProviderShuttleIntent[] }
  | { type: "ask_user"; directive: AskUserDirective }
  | { type: "complete"; directive: CompleteDirective }
  | { type: "walk_back_to"; step: string; reason: string }
  | { type: "halt"; directive: ErrorDirective };

// Stage-result directive payloads. The kernel re-wraps these into the
// outgoing `KernelDirective` at the tick boundary (adding the
// driver_state_id and re-tagging `type` → `kind`). Co-located here so
// the `Stage` neighbourhood is self-contained.
export interface AskUserDirective {
  gate: string;
  gate_event_id: string;
  message: string;
  valid_answers: UserAnswerSchema;
}

export interface CompleteDirective {
  task_id: string | null;
  verdict: "accepted" | "rejected" | "failed_force_closed";
  summary: string;
}

export interface ErrorDirective {
  code: string;
  message: string;
  recovery_options: { choice: string; label: string; agent_run_ids?: string[] }[];
}

// Effects a Step asserts it MAY write. Discriminated union — the
// loader cross-checks that no two Steps declare the same effect
// target.
export type StepEffect =
  | { kind: "state.write"; field: string }
  | { kind: "decisions.set"; key: string }
  | { kind: "bundle_state.set"; path: string }
  | { kind: "finding.insert"; phase: Phase }
  | { kind: "audit.emit"; type: string };

// Kernel-default event names plus the open-string branch for bundle
// extensions. The bundle-loader validates a Step's `event` against the
// merged kernel-default + bundle-extension set; raw strings outside
// the merged set surface at load, not at first fire.
export type HookEvent =
  | "before-spawn"
  | "after-spawn"
  | "before-fanout"
  | "after-fanout"
  | "before-gate"
  | "after-gate"
  | "before-step"
  | "after-step"
  | "before-finalize"
  | "after-finalize"
  | "after-agent-result"
  | "before-agent-spawn"
  | "before-context-pressure"
  | "gate-decision"
  | "on-error"
  | (string & {});

// ----- SpawnStage ---------------------------------------------------------

export interface SpawnStage {
  kind: "spawn";
  name: string;
  phase: Phase;
  agent: string;
}

// ----- FanoutStage --------------------------------------------------------

export interface FanoutStage {
  kind: "fanout";
  name: string;
  phase: Phase;
  agents: string[];
  filter_by_change_kind?: boolean;
  on_results?: (
    state: BundleStateView,
    results: AgentResult[],
    ctx: StageContext,
  ) => Promise<StageResult>;
  iteration_budget?: AttemptBudget;
  spawn_budget?: TimeBudget;
  max_concurrent_spawns?: number;
}

// ----- GateStage ----------------------------------------------------------

export interface GateStage {
  kind: "gate";
  name: string;
  phase: Phase;
  message: (state: BundleStateView) => string | Promise<string>;
  valid_answers: (
    state: BundleStateView,
  ) => UserAnswerSchema | Promise<UserAnswerSchema>;
  on_resume?: (
    state: BundleStateView,
    answer: UserAnswer,
    ctx: StageContext,
  ) => Promise<StageResult>;
  on_pre_ask?: (
    state: BundleStateView,
    ctx: StageContext,
  ) =>
    | { type: "advance" }
    | { type: "ask_user"; directive: AskUserDirective }
    | null
    | Promise<
        | { type: "advance" }
        | { type: "ask_user"; directive: AskUserDirective }
        | null
      >;
}

// ----- StepStage ----------------------------------------------------------

export interface StepStage {
  kind: "step";
  name: string;
  phase?: Phase;
  // "positional" — listed in a flow; runs at that index.
  // "event"      — subscribes to a kernel event; not present in flow[],
  //                dispatched in-tx via `dispatchEventSteps`.
  position: "positional" | "event";
  event?: HookEvent;
  filter?: string | RegExp | ((ctx: StageContext) => boolean);
  effects: StepEffect[];
  run?: (state: BundleStateView, ctx: StageContext) => Promise<void>;
  applies_to?: (state: BundleStateView) => boolean;
}

// ----- FinalizeStage ------------------------------------------------------

// FinalizeStage has NO `phase` field — the kind discriminant alone
// signals "FSM terminator". The closed union lets the type system
// enforce the exception without sentinel strings in validators.
export interface FinalizeStage {
  kind: "finalize";
  name: string;
}

// ============================================================================
// Other plugin contracts
// ============================================================================

export interface Hook extends PluginMeta {
  event: HookEvent | RegExp;
  filter?: string | RegExp | ((ctx: HookContext) => boolean);
  requires?: string[];
  // Side-effect hooks must be idempotent — the bundle-loader rejects
  // values other than `true` so the assertion is explicit in source.
  idempotent?: true;
  run(ctx: HookContext): Promise<void>;
}

export interface MCPClientPlugin extends PluginMeta {
  endpoint: string;
  scope: "task" | "global";
  call_budget?: TimeBudget;
  tool_idempotency?: Record<string, boolean>;
}

export interface SandboxPlugin extends PluginMeta {
  kind: string;
  exec(
    command: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exit_code: number }>;
}

export type Sandbox = SandboxPlugin;

// Re-exported here for readers who only need the Stage neighbourhood —
// the kernel barrel exports the same names from `./row-types.js`.
export type { GateRole, Phase };
