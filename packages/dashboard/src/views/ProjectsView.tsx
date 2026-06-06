import { useCallback, useEffect, useState } from "react";

import { StatusBadge } from "../components/StatusBadge.js";
import { api, ApiError, errText } from "../lib/api.js";
import { flowMeta } from "../lib/status.js";
import type { ProjectListing, WorkspaceProject, WorkspaceResponse } from "../lib/types.js";
import styles from "./ProjectsView.module.css";

const POLL_MS = 4000;

// Load the project list. `GET /workspace` (the catalog + status) is the primary
// source; it requires the config API (a `loomHome`-configured server). A server
// without it answers 501 — fall back to `GET /projects` (the live supervised
// set) so the view works on any deployment.
async function loadProjects(): Promise<WorkspaceProject[]> {
  try {
    const ws = await api<WorkspaceResponse>("GET", "/workspace");
    return ws.projects;
  } catch (err) {
    if (err instanceof ApiError && err.status === 501) {
      const live = await api<ProjectListing[]>("GET", "/projects");
      return live.map((p) => ({ id: p.id, dir: p.dir, status: p.status }));
    }
    throw err;
  }
}

export interface ProjectsViewProps {
  // Open a project's detail view. Carries the fields the detail needs so it can
  // render its header before the first SSE tick.
  onOpen: (project: { id: string; dir: string; label?: string }) => void;
}

export function ProjectsView({ onOpen }: ProjectsViewProps) {
  const [projects, setProjects] = useState<WorkspaceProject[] | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const reload = useCallback(async () => {
    try {
      setProjects(await loadProjects());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  return (
    <div>
      <div className={styles.head}>
        <h1>Projects</h1>
        <button className={styles.refresh} onClick={() => void reload()}>
          refresh
        </button>
      </div>

      {error && <div className={styles.error}>{errText(error)}</div>}

      {projects && projects.length === 0 && (
        <div className={styles.empty}>
          No projects yet — add one from the catalog or submit a task to a directory.
        </div>
      )}

      {projects && projects.length > 0 && (
        <div className={styles.grid}>
          {projects.map((p) => {
            const meta = flowMeta(p.status);
            return (
              <button
                type="button"
                className={styles.card}
                key={p.id}
                onClick={() => onOpen({ id: p.id, dir: p.dir, ...(p.label !== undefined ? { label: p.label } : {}) })}
              >
                <div className={styles.cardHead}>
                  <span className={styles.id}>{p.label ?? p.id}</span>
                  <StatusBadge status={p.status} />
                </div>
                <div className={styles.dir}>{p.dir}</div>
                {meta !== null && <div className={styles.meta}>{meta}</div>}
                {p.status?.task_label && <div className={styles.meta}>{p.status.task_label}</div>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
