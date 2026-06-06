import { useApi, type ApiState } from "./useApi.js";
import type { ProvidersResponse } from "../lib/types.js";

// The backends + provider families + availability signal (`GET /providers`), and
// the per-task Docker capability that rides on it. A thin typed wrapper over
// `useApi` so the views that read providers (the Providers page, the project
// detail's Docker checkbox, the model-map editor) share one fetch shape.
export function useProviders(intervalMs?: number): ApiState<ProvidersResponse> {
  return useApi<ProvidersResponse>("/providers", intervalMs);
}
