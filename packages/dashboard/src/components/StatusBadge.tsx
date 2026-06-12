// The operator-facing status pill — a tone-coloured Mantine badge with a dot
// that pulses only while a task is actively in_progress. Shared by the project
// grid, the attention strip, and the detail header. Domain-blind: it reads only
// the generic read-model status via `statusBadge`, never a bundle's gate
// meaning.

import { Badge } from "@mantine/core";

import { cx } from "../lib/cx.js";
import { statusBadge, type StatusTone } from "../lib/status.js";
import type { ProjectStatus } from "../lib/types.js";
import styles from "./StatusBadge.module.css";

const TONE_COLOR: Record<StatusTone, string> = {
  idle: "gray",
  ok: "green",
  warn: "yellow",
  bad: "red",
};

export function StatusBadge({ status }: { status: ProjectStatus | null | undefined }) {
  const badge = statusBadge(status);
  // Pulse only while genuinely running (a completed-accepted badge is also tone
  // "ok" but must stay steady).
  const running = status?.has_task === true && status.status === "in_progress";
  return (
    <Badge
      variant="light"
      color={TONE_COLOR[badge.tone]}
      leftSection={<span className={cx(styles.dot, running && styles.pulse)} />}
      styles={{ label: { textTransform: "none", fontWeight: 600 } }}
    >
      {badge.label}
    </Badge>
  );
}
