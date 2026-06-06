// The operator-facing status pill — a tone-coloured dot + the collapsed status
// label, pulsing only while a task is actively in_progress. Shared by the
// project grid and the detail header (the R3 de-dup of the duplicated DOT_CLASS
// map + dot markup). Domain-blind: it reads only the generic read-model status
// via `statusBadge`, never a bundle's gate meaning.

import { cx } from "../lib/cx.js";
import { statusBadge, type StatusTone } from "../lib/status.js";
import type { ProjectStatus } from "../lib/types.js";
import styles from "./StatusBadge.module.css";

const DOT_CLASS: Record<StatusTone, string | undefined> = {
  idle: styles.idle,
  ok: styles.ok,
  warn: styles.warn,
  bad: styles.bad,
};

export function StatusBadge({ status }: { status: ProjectStatus | null | undefined }) {
  const badge = statusBadge(status);
  // Pulse only while genuinely running (a completed-accepted dot is also tone
  // "ok" but must stay steady).
  const running = status?.has_task === true && status.status === "in_progress";
  return (
    <span className={styles.badge}>
      <span className={cx(styles.dot, DOT_CLASS[badge.tone], running && styles.pulse)} />
      {badge.label}
    </span>
  );
}
