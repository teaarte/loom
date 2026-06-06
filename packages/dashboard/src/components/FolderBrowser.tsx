// An in-app folder picker over `GET /fs/list` — navigate the host filesystem
// (bounded to the server's browse root) to pick a project directory, including a
// brand-new empty one (which a native file dialog cannot return). Click a folder
// to descend, "↑ up" to go to the parent (disabled at the root), and "use this
// folder" to select the directory currently shown. Domain-blind: it lists paths
// and names nothing. The add-project form keeps a manual-path field for a target
// outside the browse root.

import { Box, Button, Group, Paper, ScrollArea, Text, UnstyledButton } from "@mantine/core";
import { useState } from "react";

import { useApi } from "../hooks/useApi.js";
import { errText } from "../lib/api.js";
import type { FsListResponse } from "../lib/types.js";

export function FolderBrowser({ onPick }: { onPick: (path: string) => void }) {
  // The directory being browsed; null asks the server for the root.
  const [path, setPath] = useState<string | null>(null);
  const { data, error } = useApi<FsListResponse>(
    path === null ? "/fs/list" : `/fs/list?path=${encodeURIComponent(path)}`,
  );

  return (
    <Paper withBorder radius="md" p="sm">
      <Group justify="space-between" align="center" wrap="nowrap" mb="xs">
        <Button
          size="compact-sm"
          variant="default"
          disabled={data?.parent == null}
          onClick={() => data?.parent != null && setPath(data.parent)}
        >
          ↑ up
        </Button>
        <Text size="xs" c="dimmed" style={{ flex: 1, wordBreak: "break-all" }} ta="center">
          {data?.path ?? "…"}
        </Text>
        <Button size="compact-sm" disabled={data === null} onClick={() => data !== null && onPick(data.path)}>
          use this folder
        </Button>
      </Group>

      {error !== null && (
        <Text size="xs" c="red">
          {errText(error)}
        </Text>
      )}

      <ScrollArea.Autosize mah={220} type="auto">
        <Box>
          {data === null && error === null && (
            <Text size="sm" c="dimmed">
              reading…
            </Text>
          )}
          {data !== null && data.entries.length === 0 && (
            <Text size="sm" c="dimmed">
              (no subfolders here)
            </Text>
          )}
          {data?.entries.map((e) => (
            <UnstyledButton
              key={e.path}
              onClick={() => setPath(e.path)}
              display="block"
              w="100%"
              p={4}
              style={{ borderRadius: 4 }}
            >
              <Text size="sm">📁 {e.name}</Text>
            </UnstyledButton>
          ))}
        </Box>
      </ScrollArea.Autosize>
    </Paper>
  );
}
