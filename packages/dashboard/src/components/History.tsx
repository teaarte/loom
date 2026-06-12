// The finished-task browser: a project's archived tasks, each openable into the
// SAME chain view as the active one (read-only, over its archived store). The
// data is already on disk — this is just another store path. Domain-blind: it
// shows generic status / verdict / timing and names no bundle vocabulary.

import { Badge, Box, Group, Paper, Stack, Text, UnstyledButton } from "@mantine/core";
import { useState } from "react";

import { useApi } from "../hooks/useApi.js";
import { elapsedFor, formatClock } from "../lib/format.js";
import type { HistoryResponse, HistoryTask } from "../lib/types.js";
import { Trace } from "./Trace.js";

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

function verdictColor(t: HistoryTask): string {
  if (t.verdict === "accepted") return "green";
  if (t.verdict === "rejected") return "yellow";
  return "gray";
}

export function History({ projectId }: { projectId: string }) {
  const { data } = useApi<HistoryResponse>(`/projects/${encodeURIComponent(projectId)}/history`, 10000);
  const [openId, setOpenId] = useState<string | null>(null);

  if (data === null)
    return (
      <Text size="sm" c="dimmed">
        reading history…
      </Text>
    );
  if (data.tasks.length === 0)
    return (
      <Text size="sm" c="dimmed">
        no finished tasks yet
      </Text>
    );

  return (
    <Stack gap={6}>
      {data.tasks.map((t) => {
        const canOpen = t.task_id !== null;
        const isOpen = canOpen && openId === t.task_id;
        return (
          <Paper key={t.db_file} p={0}>
            <UnstyledButton
              w="100%"
              p="xs"
              onClick={() => canOpen && setOpenId(isOpen ? null : t.task_id)}
              style={{ cursor: canOpen ? "pointer" : "default" }}
            >
              <Group gap="sm" wrap="nowrap">
                {canOpen && (
                  <Text span size="sm" c="dimmed" style={{ flexShrink: 0 }}>
                    {isOpen ? "▾" : "▸"}
                  </Text>
                )}
                <Text size="sm" truncate style={{ flex: 1, minWidth: 0 }}>
                  {label(t)}
                </Text>
                <Badge size="sm" variant="light" color={verdictColor(t)} styles={{ label: { textTransform: "none" } }}>
                  {verdictLabel(t)}
                </Badge>
                {t.started_at !== null && (
                  <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                    {elapsedFor(t.started_at, t.ended_at, 0)}
                  </Text>
                )}
                {t.archived_at !== null && (
                  <Text size="xs" c="dimmed" style={{ flexShrink: 0 }} visibleFrom="xs">
                    {formatClock(t.archived_at)}
                  </Text>
                )}
              </Group>
            </UnstyledButton>
            {isOpen && t.task_id !== null && (
              <Box p="sm" pt={0}>
                <Trace projectId={projectId} archivedTaskId={t.task_id} />
              </Box>
            )}
          </Paper>
        );
      })}
    </Stack>
  );
}
