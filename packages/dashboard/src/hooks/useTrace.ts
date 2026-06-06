import { useApi, type ApiState } from "./useApi.js";
import type { TraceResponse } from "../lib/types.js";

// A task's recorded agent chain (`GET /projects/:id/trace`). The live chain may
// grow as spawns complete, so it polls; an archived chain (`?task=<id>`) is
// static, so it is fetched once. Domain-blind: the response carries only generic
// FSM columns — the consuming view names no agent/gate/bundle vocabulary.
export function useTrace(projectId: string, archivedTaskId?: string): ApiState<TraceResponse> {
  const base = `/projects/${encodeURIComponent(projectId)}/trace`;
  const path = archivedTaskId !== undefined ? `${base}?task=${encodeURIComponent(archivedTaskId)}` : base;
  return useApi<TraceResponse>(path, archivedTaskId === undefined ? 4000 : undefined);
}
