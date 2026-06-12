// The one shared source of fleet data: the workspace catalog joined with each
// project's read-model status. Owned by the App shell so the home view, the
// navbar's attention badge, and deep-linked detail routes all read the same
// 4-second snapshot instead of fetching three times.
//
// `GET /workspace` is primary; a server without the config API answers 501 and
// the hook falls back to `GET /projects` (the live supervised set). Polling
// pauses while the tab is hidden — a background dashboard should cost nothing.

import { useCallback, useEffect, useState } from "react";

import { api, ApiError } from "../lib/api.js";
import type { ProjectListing, WorkspaceProject, WorkspaceResponse } from "../lib/types.js";

const POLL_MS = 4000;

async function loadProjects(): Promise<WorkspaceProject[]> {
  try {
    const ws = await api<WorkspaceResponse>("GET", "/workspace");
    // A reverse proxy or static host answering 200 with non-API content must
    // read as an error, not a crash.
    if (ws === null || !Array.isArray(ws.projects)) throw new Error("unexpected /workspace response");
    return ws.projects;
  } catch (err) {
    if (err instanceof ApiError && err.status === 501) {
      const live = await api<ProjectListing[]>("GET", "/projects");
      return live.map((p) => ({ id: p.id, dir: p.dir, status: p.status }));
    }
    throw err;
  }
}

export interface FleetState {
  projects: WorkspaceProject[] | null;
  error: Error | null;
  reload: () => void;
}

export function useFleet(): FleetState {
  const [projects, setProjects] = useState<WorkspaceProject[] | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const reload = useCallback(() => {
    void (async () => {
      try {
        setProjects(await loadProjects());
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  }, []);

  useEffect(() => {
    reload();
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") reload();
    }, POLL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload]);

  return { projects, error, reload };
}

// The fleet rows that need the operator right now — a parked gate or a stall.
// Pure, shared by the home view's attention strip and the navbar badge.
export function needsAttention(projects: WorkspaceProject[] | null): WorkspaceProject[] {
  if (projects === null) return [];
  return projects.filter(
    (p) => p.status?.parked_gate != null || p.status?.stalled === true,
  );
}
