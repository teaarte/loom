// A thin client of the loom control-plane HTTP API — the SAME bearer contract
// the dashboard uses (`Authorization: Bearer <token>`) and the same error
// envelope `{ error: { code, message } }`, kept verbatim. The control plane is
// the authority; this only speaks HTTP to it over loopback. `FetchLike` is
// injectable so the bot's tests drive it with a fake (no live server).
//
// Domain-blind: `complexity` values and gate `decision`/`reject_intent` are
// generic create-args / FSM vocabulary passed straight through — the client
// hard-codes no agent, tier, or bundle name.

import type { ProjectStatusView } from "../read-model.js";
import type { FetchLike } from "./telegram.js";

// Every call returns a discriminated result so a refusal becomes a readable
// reply rather than a thrown error — the bot must never go silent on a bad call.
export type ApiResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

export interface SubmitBody {
  project: string;
  task: string;
  complexity?: string;
  policy_preset?: string;
  docker?: boolean;
}
export interface SubmitWire {
  id: string;
  dir: string;
  task_id: string | null;
  status: string;
  replayed: boolean;
}

export interface AnswerBody {
  gate_event_id: string;
  decision: "accept" | "reject" | "auto-apply";
  reject_intent?: "revise" | "abandon";
  message?: string;
}
export interface AnswerWire {
  id: string;
  status: string;
}

export interface ProjectWire {
  id: string;
  dir: string;
  supervised: boolean;
  status: ProjectStatusView;
}

export interface WorkspaceProjectWire {
  id: string;
  dir: string;
  label?: string;
  status: ProjectStatusView;
}
export interface WorkspaceWire {
  projects: WorkspaceProjectWire[];
}

export interface ProviderEntryWire {
  backend: string;
  available: boolean | null;
  reason?: string;
}
export interface ProvidersWire {
  backend_mode: string;
  providers: ProviderEntryWire[];
  docker?: { available: boolean; reason?: string };
}

export interface TraceAgentWire {
  agent: string;
  phase: string;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  recorded_at: string;
}
export interface TraceSummaryWire {
  task_id: string | null;
  status: string | null;
  verdict: string | null;
  started_at: string | null;
  ended_at: string | null;
  task: string | null;
  completion_summary: string | null;
}
export interface TraceWire {
  archived: boolean;
  summary: TraceSummaryWire | null;
  agents: TraceAgentWire[];
}

export interface ArtifactWire {
  path: string;
  content: string;
  truncated: boolean;
}
export interface ArtifactEntryWire {
  path: string;
  size: number;
  modified_at: string | null;
}
export interface ArtifactsWire {
  artifacts: ArtifactEntryWire[];
}

// The push / squash-merge result, surfaced verbatim so a clean refusal (no
// remote, dirty tree, not a git repo) reaches the operator as a readable reply.
export interface ShipWire {
  id: string;
  dir: string;
  pushed?: boolean;
  merged?: boolean;
  branch?: string;
  remote?: string;
  into?: string;
  files_changed?: string[];
  reason?: string;
  detail?: string;
}

export interface LoomClient {
  submit(body: SubmitBody): Promise<ApiResult<SubmitWire>>;
  answer(projectId: string, body: AnswerBody): Promise<ApiResult<AnswerWire>>;
  getProject(projectId: string): Promise<ApiResult<ProjectWire>>;
  listProjects(): Promise<ApiResult<WorkspaceWire>>;
  getProviders(): Promise<ApiResult<ProvidersWire>>;
  getTrace(projectId: string): Promise<ApiResult<TraceWire>>;
  getArtifact(projectId: string, path: string): Promise<ApiResult<ArtifactWire>>;
  listArtifacts(projectId: string): Promise<ApiResult<ArtifactsWire>>;
  cancel(projectId: string): Promise<ApiResult<{ id: string }>>;
  push(projectId: string): Promise<ApiResult<ShipWire>>;
  merge(projectId: string): Promise<ApiResult<ShipWire>>;
}

export function makeLoomClient(fetchImpl: FetchLike, baseUrl: string, token?: string): LoomClient {
  const request = async <T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> => {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(token !== undefined && token.length > 0 ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      return { ok: false, code: "NETWORK", message: err instanceof Error ? err.message : String(err) };
    }
    const raw = await res.text();
    let data: unknown = null;
    try {
      data = raw.length > 0 ? JSON.parse(raw) : null;
    } catch {
      /* a non-JSON body — leave data null and fall through */
    }
    if (!res.ok) {
      const env = data as { error?: { code?: string; message?: string } } | null;
      return {
        ok: false,
        code: env?.error?.code ?? `HTTP_${res.status}`,
        message: env?.error?.message ?? `HTTP ${res.status}`,
      };
    }
    return { ok: true, data: data as T };
  };

  const enc = encodeURIComponent;
  return {
    submit: (body) => request<SubmitWire>("POST", "/submit", body),
    answer: (id, body) => request<AnswerWire>("POST", `/projects/${enc(id)}/answer`, body),
    getProject: (id) => request<ProjectWire>("GET", `/projects/${enc(id)}`),
    listProjects: () => request<WorkspaceWire>("GET", "/workspace"),
    getProviders: () => request<ProvidersWire>("GET", "/providers"),
    getTrace: (id) => request<TraceWire>("GET", `/projects/${enc(id)}/trace`),
    getArtifact: (id, path) => request<ArtifactWire>("GET", `/projects/${enc(id)}/artifact?path=${enc(path)}`),
    listArtifacts: (id) => request<ArtifactsWire>("GET", `/projects/${enc(id)}/artifacts`),
    cancel: (id) => request<{ id: string }>("POST", `/projects/${enc(id)}/cancel`),
    push: (id) => request<ShipWire>("POST", `/projects/${enc(id)}/push`),
    merge: (id) => request<ShipWire>("POST", `/projects/${enc(id)}/merge`),
  };
}
