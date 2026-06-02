// Plugin contracts — the canonical definitions.
//
// The full shapes below (`Agent` / `Stage` + its five variants / `Hook`
// / `MCPClientPlugin` / `SandboxPlugin` / `AgentOutputKind` /
// `PluginMeta`) ARE the contracts the kernel surface, providers, and
// bundles compile against — there is no separate contracts package they
// extend. Keeping them co-located with the kernel barrel gives plugin
// authors one import path and avoids ossifying a package boundary before
// a second consumer proves where the seam belongs.
//
// `LLMProvider` is the one contract that lives in `provider.ts` instead
// of here — it pulls in `ProviderResult` / `ProviderSpawnRequest`
// directly, so co-locating with those keeps imports flat.
//
// The Stage union is the heart of the FSM execution surface — five
// disjoint kinds (spawn / fanout / gate / step / finalize) cover every
// possible flow step. Loader checks are exhaustive precisely because
// the discriminant set is closed; a new kind requires a new variant
// and a new interpreter, in lockstep.

import type { AttemptBudget, TimeBudget } from "./budget.js";
import type { AgentResult } from "./agent-result.js";
import type {
  AgentRecordsAccess,
  FindingsAccess,
  HookContext,
  StageContext,
} from "./context.js";
import type { NowToken } from "./now.js";
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
//
// `nonreview` is kernel-baseline because the agent-result builder
// reads it in a structural switch: an output flagged `nonreview` skips
// the JSON-fence / findings-parsing branches and returns the bare
// agent result. Removing the literal would force every downstream
// caller that exercises that switch to declare a bundle-extension
// just to opt into kernel-shipped persistence behavior.
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
  | { kind: "finding.status.update" }
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

// The generic outcome subset an escalation predicate reads. Mirrors the
// accessor surface a `Policy` receives — findings (severity/category/
// status + (phase,iteration) provenance) and agent records — plus the
// threaded NowToken. It exposes NO driver internals and NO code-specific
// shapes: a predicate stays domain-blind by reading only this subset
// alongside the `BundleStateView` it is also handed (decisions, and
// `agent_verdicts` for verdict-spread across agents on a target).
export interface ConditionalSpawnContext {
  findings: FindingsAccess;
  agents_query: AgentRecordsAccess;
  now: NowToken;
}

// A bundle-supplied predicate that decides, from the generic outcome
// subset, whether a SpawnStage actually launches. Must be deterministic
// (no wall-clock, no randomness) — the kernel re-evaluates it verbatim on
// replay, so a non-deterministic predicate would break the same-input →
// same-directive contract the idempotency ledger relies on.
export type ConditionalSpawnPredicate = (
  state: BundleStateView,
  ctx: ConditionalSpawnContext,
) => boolean;

export interface SpawnStage {
  kind: "spawn";
  name: string;
  phase: Phase;
  agent: string;
  // Optional spawn gate, evaluated AFTER `Agent.applies_to`. When present
  // and it returns false the stage advances WITHOUT launching anything;
  // true (or absent) runs the unconditional spawn path unchanged. This is
  // the generic "verify/escalate only when the outcome warrants it"
  // primitive: the bundle supplies the predicate over generic shapes
  // (findings / verdict-spread / decisions); the kernel names no domain
  // concept. Distinct from `Agent.applies_to` (agent-intrinsic, reads only
  // the state view): a stage `when` reads the findings/verdict outcome the
  // view cannot carry, and is the flow SITE's escalation condition rather
  // than the agent's applicability — the two coexist, and both must pass
  // for a spawn to fire.
  when?: ConditionalSpawnPredicate;
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

// The outer process-isolation boundary. Concrete kinds advertise what
// they actually contain via `capabilities`; a kind that cannot honour a
// capability MUST report it false rather than silently no-op (an
// agent/operator reading the matrix should never be misled about what is
// contained). The cross-platform default is filesystem-discipline only;
// native OS isolation and containerized kinds land additively against
// this same contract.
export type SandboxKind =
  | "passthrough" // no isolation; dev only
  | "path-restricted" // filesystem path discipline; cross-platform default
  | "sandbox-exec" // macOS native, per-call
  | "bwrap" // Linux bubblewrap, per-call
  | "docker" // full container per task
  | "vm" // VM-per-task, highest isolation
  | (string & {}); // open string for community plugins

export interface ExecOptions {
  // Working directory inside the sandbox.
  cwd?: string;
  // Environment variables for this exec; merged with sandbox-level env.
  env?: Record<string, string>;
  // Hard timeout in milliseconds. The sandbox kills the process if exceeded.
  timeout_ms?: number;
  // stdin to feed (rare; bash-like tools use this).
  stdin?: string;
}

export interface ExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  // Wall-clock duration of the exec. The substrate never reads a clock
  // (replay determinism), so a sandbox that cannot self-time reports 0
  // and the calling tool-runner stamps the real elapsed time.
  duration_ms: number;
  timed_out: boolean;
}

export interface SandboxConfig {
  // Mounted directories. The project workspace is mounted read-write by default.
  mounts: { host_path: string; sandbox_path: string; mode: "ro" | "rw" }[];
  // Network egress allow-list (host:port pairs).
  network_allow?: string[];
  // Resource limits.
  limits?: { cpu?: number; memory_mb?: number; disk_mb?: number; pids?: number };
  // Environment variable names to pass through.
  env_passthrough?: string[];
}

export interface SandboxPlugin extends PluginMeta {
  // The plugin's identity IS its kind — `name` carries the SandboxKind.
  name: SandboxKind;

  // Capabilities advertised. A boolean here is a promise: `true` means the
  // boundary genuinely contains that axis.
  capabilities: {
    filesystem_isolation: boolean;
    network_isolation: boolean;
    process_isolation: boolean;
    resource_limits: boolean;
  };

  // Prepare the sandbox (spin up a container, build a bwrap profile, …).
  initialize?(config: SandboxConfig): Promise<void>;

  // Execute a command inside the sandbox. A Bash-shaped tool delegates here
  // when the sandbox is active.
  exec(cmd: string, opts: ExecOptions): Promise<ExecResult>;

  // Read a file through the sandbox boundary.
  read_file(path: string): Promise<string>;

  // Write a file through the sandbox boundary.
  write_file(path: string, content: string): Promise<void>;

  // Tear down (stop a container, remove temp profiles, …).
  shutdown?(): Promise<void>;
}

export type Sandbox = SandboxPlugin;

// Re-exported here for readers who only need the Stage neighbourhood —
// the kernel barrel exports the same names from `./row-types.js`.
export type { GateRole, Phase };
