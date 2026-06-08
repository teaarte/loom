// The finished-task browser: a project's archived tasks, each openable into the
// SAME chain view as the active one (read-only, over its archived store). The
// data is already on disk — this is just another store path. Domain-blind: it
// shows generic status / verdict / timing and names no bundle vocabulary.

import { useState } from "react";

import { useApi } from "../hooks/useApi.js";
import { cx } from "../lib/cx.js";
import { elapsedFor, formatClock } from "../lib/format.js";
import type { HistoryResponse, HistoryTask } from "../lib/types.js";
import { Trace } from "./Trace.js";
import styles from "./History.module.css";

function label(t: HistoryTask): string {
  if (t.task_short !== null && t.task_short.length > 0) return t.task_short;
  if (t.task !== null && t.task.length > 0) return t.task.length > 80 ? `${t.task.slice(0, 77)}…` : t.task;
  return t.task_id ?? t.db_file;
}

function verdictLabel(t: HistoryTask): string {
  if (t.verdict !== null) return t.verdict;
  // A task archived while still in_progress (no verdict) was discarded via a
  // force-reset — show that rather than the frozen "in_progress", which reads
  // as if it were still running.
  if (t.status === "in_progress") return "discarded";
  if (t.status !== null) return t.status;
  return "archived";
}

export function History({ projectId }: { projectId: string }) {
  const { data } = useApi<HistoryResponse>(`/projects/${encodeURIComponent(projectId)}/history`, 10000);
  const [openId, setOpenId] = useState<string | null>(null);

  if (data === null) return <div className={styles.note}>reading history…</div>;
  if (data.tasks.length === 0) return <div className={styles.note}>no finished tasks yet</div>;

  return (
    <div>
      {data.tasks.map((t) => {
        const canOpen = t.task_id !== null;
        const isOpen = canOpen && openId === t.task_id;
        return (
          <div key={t.db_file} className={styles.item}>
            <button
              className={cx(styles.row, canOpen && styles.clickable)}
              onClick={() => canOpen && setOpenId(isOpen ? null : t.task_id)}
            >
              {canOpen && <span className={styles.caret}>{isOpen ? "▾" : "▸"}</span>}
              <span className={styles.label}>{label(t)}</span>
              <span className={cx(styles.verdict, t.verdict === "rejected" && styles.rejected)}>
                {verdictLabel(t)}
              </span>
              {t.started_at !== null && (
                <span className={styles.elapsed}>{elapsedFor(t.started_at, t.ended_at, 0)}</span>
              )}
              {t.archived_at !== null && <span className={styles.when}>{formatClock(t.archived_at)}</span>}
            </button>
            {isOpen && t.task_id !== null && (
              <div className={styles.body}>
                <Trace projectId={projectId} archivedTaskId={t.task_id} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
