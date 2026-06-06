import { useApi, type ApiState } from "./useApi.js";
import type { HistoryResponse } from "../lib/types.js";

// A project's finished-task browser (`GET /projects/:id/history`), polled gently
// so a freshly-archived task appears without a manual refresh. The data is on
// disk (archived stores), so the cadence is slow.
export function useHistory(projectId: string): ApiState<HistoryResponse> {
  return useApi<HistoryResponse>(`/projects/${encodeURIComponent(projectId)}/history`, 10000);
}
