import { useCallback, useState } from "react";

import { api } from "../lib/api.js";
import type { BackendModelsResponse } from "../lib/types.js";

export interface ModelListState {
  // The per-backend model-list cache (empty list cached too → free-text fallback).
  modelsByBackend: Record<string, BackendModelsResponse>;
  // Lazily fetch + cache a backend's model list when its dropdown is first chosen.
  loadModels: (backend: string) => Promise<void>;
}

// The lazy, per-backend model-list cache behind the model-map editor's dropdown
// (`GET /providers/:backend/models`). A failed/empty list is cached too, so the
// row falls back to free-text without re-fetching. Extracted so the model
// picker's data concern is reusable (the editor + any future per-agent picker).
export function useModelList(): ModelListState {
  const [modelsByBackend, setModelsByBackend] = useState<Record<string, BackendModelsResponse>>({});

  const loadModels = useCallback(
    async (backend: string): Promise<void> => {
      if (backend.length === 0) return;
      // Read the latest cache inside the updater so the callback identity stays
      // stable (no `modelsByBackend` dependency → no refetch churn).
      let alreadyCached = false;
      setModelsByBackend((m) => {
        alreadyCached = m[backend] !== undefined;
        return m;
      });
      if (alreadyCached) return;
      try {
        const r = await api<BackendModelsResponse>("GET", `/providers/${encodeURIComponent(backend)}/models`);
        setModelsByBackend((m) => (m[backend] !== undefined ? m : { ...m, [backend]: r }));
      } catch {
        setModelsByBackend((m) =>
          m[backend] !== undefined ? m : { ...m, [backend]: { backend, models: [], reason: "could not list models" } },
        );
      }
    },
    [],
  );

  return { modelsByBackend, loadModels };
}
