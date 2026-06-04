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
  status: "in_progress" | "completed" | "abandoned" | null;
  verdict: "accepted" | "rejected" | "failed_force_closed" | null;
  flow: { name: string; step_index: number } | null;
  active_phase: string | null;
  parked_gate: { gate: string; message: string; gate_event_id: string } | null;
  pending_agents: { agent: string; phase: string; age_ms: number }[];
  stalled: boolean;
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
