// Light client-side mirrors of the API response shapes the views consume. These
// follow the server's read-model + control-layer routes; they are intentionally
// narrow (only fields a view reads) and never import a server/kernel type — the
// SPA stays decoupled and domain-blind.

// The domain-blind project status the read-model returns (`GET /projects`,
// `GET /projects/:id`, the `/workspace` join, and each SSE tick).
export interface ProjectStatus {
  project_dir: string;
  has_task: boolean;
  task_id: string | null;
  task_label: string | null;
  // The full task text (untruncated). Optional so an older server is tolerated.
  task?: string;
  status: "in_progress" | "completed" | "abandoned" | null;
  verdict: "accepted" | "rejected" | "failed_force_closed" | null;
  flow: { name: string; step_index: number } | null;
  active_phase: string | null;
  parked_gate: { gate: string; message: string; gate_event_id: string } | null;
  pending_agents: { agent: string; phase: string; age_ms: number }[];
  stalled: boolean;
  // Wall-clock bookends for total-elapsed display (ISO-8601). `ended_at` is null
  // until terminal. Optional so an older server (no field) is tolerated.
  started_at?: string | null;
  ended_at?: string | null;
}

// A row of `GET /projects` (the live supervised set).
export interface ProjectListing {
  id: string;
  dir: string;
  status: ProjectStatus;
}

// A catalog entry from `GET /workspace` (a project the operator has worked on,
// supervised or not), joined with its read-model status.
export interface WorkspaceProject {
  id: string;
  dir: string;
  label?: string;
  bundle?: string;
  added_at?: string;
  last_opened_at?: string;
  pinned?: boolean;
  status: ProjectStatus;
}

export interface WorkspaceResponse {
  projects: WorkspaceProject[];
}

// One line of a project's daemon audit log, streamed in each SSE tick alongside
// the status (`GET /projects/:id/log` → `data: { status, log }`).
export interface LogLine {
  ts?: string;
  level?: string;
  event?: string;
  detail?: Record<string, unknown>;
}

// One SSE snapshot from the live log stream.
export interface LogSnapshot {
  status: ProjectStatus;
  log: LogLine[];
  // Whether a watcher is currently attached to the project. Distinguishes a
  // running task (→ pause) from an in-flight task with no watcher — paused, or
  // recovered-but-not-yet-re-driven — the only case where "resume" does anything.
  // Optional so an older server (no field) is tolerated.
  supervised?: boolean;
}

// The result of `POST /submit` (the create-task path) — informational; the
// project's watcher drives from the first directive.
export interface SubmitResult {
  id: string;
  dir: string;
  task_id: string | null;
  driver_state_id: string;
  status: string;
  replayed: boolean;
}

// One agent's current model binding (`GET /projects/:id/agents`). `source`
// distinguishes a config override from the bundle's own default and an unset
// agent; `family` is the provider family parsed off the ref, when present.
export interface AgentBinding {
  agent: string;
  ref: string | null;
  source: "override" | "bundle-default" | "unset";
  model: string | null;
  family?: string;
}

// The bundle's roster + each agent's binding. Names are DATA off the loaded
// bundle — the view hardcodes none.
export interface AgentsResponse {
  bundle: string;
  agents: AgentBinding[];
}

// One backend's provider families + a best-effort availability signal
// (`GET /providers`). `available` is null when the server cannot know without
// spawning (a local or external-CLI backend).
export interface ProviderInfo {
  backend: string;
  families: string[];
  available: boolean | null;
  reason?: string;
}

export interface ProvidersResponse {
  backend_mode: string;
  providers: ProviderInfo[];
  // Whether per-task Docker isolation can be honoured (an image + credential are
  // configured and the Docker CLI is reachable). Absent on an older server.
  docker?: { available: boolean; reason?: string };
}

// A backend's live model list (`GET /providers/:backend/models`). `models` is
// the catalog the UI offers in a dropdown; empty when the server cannot list
// them (unknown/unreachable backend) — the UI then falls back to free-text.
export interface BackendModelsResponse {
  backend: string;
  models: string[];
  // When the list is empty, why (so the UI can annotate the free-text fallback).
  reason?: string;
}

// ----- agent-chain trace (`GET /projects/:id/trace`) ---------------------
// The recorded chain of a task's agent runs + the structured output its review
// stages produced. Every field is generic FSM DATA — agent / gate / output-kind
// names are values off the store; the view hardcodes none.

export interface TraceAgent {
  agent_run_id: string;
  agent: string;
  phase: string;
  model: string | null;
  output_kind: string;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cached: number | null;
  // ISO-8601 of when the run was persisted; per-agent duration is DERIVED from
  // the deltas between these (the first anchored to the task's `started_at`).
  recorded_at: string;
}

export interface TraceFinding {
  id: string;
  agent: string;
  phase: string;
  iteration: number;
  file: string | null;
  line_start: number | null;
  line_end: number | null;
  severity: string;
  category: string;
  summary: string;
  status: string;
  recorded_at: string;
}

export interface TraceVerdict {
  phase: string;
  agent: string;
  iteration: number;
  verdict: string;
  summary_line: string | null;
  blocking_issues: number;
  warn_issues: number;
  info_issues: number;
  recorded_at: string;
}

export interface TraceGate {
  name: string;
  status: string;
  decided_by: string;
  feedback: string | null;
  decided_at: string | null;
}

export interface TraceSummary {
  task_id: string | null;
  status: string | null;
  verdict: string | null;
  started_at: string | null;
  ended_at: string | null;
  task: string | null;
}

export interface TraceResponse {
  archived: boolean;
  summary: TraceSummary | null;
  agents: TraceAgent[];
  findings: TraceFinding[];
  verdicts: TraceVerdict[];
  gates: TraceGate[];
}

// ----- archived-task browser (`GET /projects/:id/history`) ---------------

export interface HistoryTask {
  task_id: string | null;
  db_file: string;
  task_short: string | null;
  task: string | null;
  status: string | null;
  verdict: string | null;
  started_at: string | null;
  ended_at: string | null;
  archived_at: string | null;
}

export interface HistoryResponse {
  tasks: HistoryTask[];
}

// ----- prose artifacts (`GET /projects/:id/artifacts` + `/artifact`) ------

export interface ArtifactInfo {
  path: string;
  size: number;
  modified_at: string | null;
}

export interface ArtifactsResponse {
  artifacts: ArtifactInfo[];
}

export interface ArtifactContent {
  path: string;
  content: string;
  truncated: boolean;
}

// The masked secret store (`GET /secrets`) — name → masked value (`****1234`).
// A raw value never crosses this boundary.
export interface SecretsResponse {
  secrets: Record<string, string>;
}

// The config document the UI reads (masked) and writes back whole. Open-shaped
// — the schema-driven form edits arbitrary fields; only `bundles` is named here
// because the model-map editor splices into it (the same path `loom models set`
// writes). A masked secret in any field round-trips and the server reconciles it.
export interface LoomConfigShape {
  bundles?: Record<string, { agents?: Record<string, string> } & Record<string, unknown>>;
  [key: string]: unknown;
}

// A JSON Schema node, narrowed to the shapes the config schema actually emits
// (object with fixed `properties`, open-keyed record via `additionalProperties`,
// string / integer / array). Open at the edges so an unknown future shape is
// tolerated rather than mis-typed.
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  [key: string]: unknown;
}
