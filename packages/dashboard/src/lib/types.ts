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
