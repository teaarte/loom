import { useCallback, useEffect, useState } from "react";

import { api, ApiError } from "../lib/api.js";
import { cx } from "../lib/cx.js";
import { statusBadge, type StatusTone } from "../lib/status.js";
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

const DOT_CLASS: Record<StatusTone, string | undefined> = {
  idle: styles.idle,
  ok: styles.ok,
  warn: styles.warn,
  bad: styles.bad,
};

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

      {error && (
        <div className={styles.error}>
          {error instanceof ApiError ? `${error.code}: ${error.message}` : error.message}
        </div>
      )}

      {projects && projects.length === 0 && (
        <div className={styles.empty}>
          No projects yet — add one from the catalog or submit a task to a directory.
        </div>
      )}

      {projects && projects.length > 0 && (
        <div className={styles.grid}>
          {projects.map((p) => {
            const badge = statusBadge(p.status);
            return (
              <button
                type="button"
                className={styles.card}
                key={p.id}
                onClick={() => onOpen({ id: p.id, dir: p.dir, ...(p.label !== undefined ? { label: p.label } : {}) })}
              >
                <div className={styles.cardHead}>
                  <span className={styles.id}>{p.label ?? p.id}</span>
                  <span className={styles.badge}>
                    <span
                      className={cx(
                        styles.dot,
                        DOT_CLASS[badge.tone],
                        p.status?.status === "in_progress" && styles.pulse,
                      )}
                    />
                    {badge.label}
                  </span>
                </div>
                <div className={styles.dir}>{p.dir}</div>
                {p.status?.flow && (
                  <div className={styles.meta}>
                    {p.status.flow.name} @ step {p.status.flow.step_index}
                    {p.status.active_phase ? ` · ${p.status.active_phase}` : ""}
                  </div>
                )}
                {p.status?.task_label && <div className={styles.meta}>{p.status.task_label}</div>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
