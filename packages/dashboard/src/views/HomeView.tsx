// The operator's landing screen, in priority order: (1) what needs ME right
// now — every parked gate and stall across the fleet, answerable one click
// away; (2) the fleet itself — informative project cards. Reads the shared
// fleet snapshot owned by the App shell (one 4s poll for the whole chrome).

import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Menu,
  Modal,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useState } from "react";

import { IconAlert } from "../components/icons.js";
import { StatusBadge } from "../components/StatusBadge.js";
import type { FleetState } from "../hooks/useFleet.js";
import { needsAttention } from "../hooks/useFleet.js";
import { api, errText } from "../lib/api.js";
import { flowMeta } from "../lib/status.js";
import type { WorkspaceProject } from "../lib/types.js";

export interface HomeViewProps {
  fleet: FleetState;
  onOpen: (id: string) => void;
  onAdd: () => void;
}

function fleetCounts(projects: WorkspaceProject[]): string[] {
  let running = 0;
  let parked = 0;
  let idle = 0;
  let finished = 0;
  for (const p of projects) {
    const s = p.status;
    if (!s?.has_task) idle += 1;
    else if (s.parked_gate || s.stalled) parked += 1;
    else if (s.status === "in_progress") running += 1;
    else finished += 1;
  }
  const out: string[] = [];
  if (running > 0) out.push(`${running} running`);
  if (parked > 0) out.push(`${parked} need you`);
  if (finished > 0) out.push(`${finished} finished`);
  if (idle > 0) out.push(`${idle} idle`);
  return out;
}

// One parked/stalled row in the attention strip — the gate name + message head
// is usually enough to know whether it's a ten-second answer or a sit-down.
function AttentionCard({ p, onOpen }: { p: WorkspaceProject; onOpen: (id: string) => void }) {
  const gate = p.status?.parked_gate;
  const headline = gate ? `parked: ${gate.gate}` : "stalled";
  const message = gate?.message ?? "no progress and nothing pending — likely needs a nudge";
  return (
    <Card
      withBorder
      padding="sm"
      style={{ cursor: "pointer", borderColor: "var(--mantine-color-yellow-5)" }}
      onClick={() => onOpen(p.id)}
    >
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Group gap={8} wrap="nowrap">
            <Text fw={600} size="sm" truncate>
              {p.label ?? p.id}
            </Text>
            <Badge size="sm" color="yellow" variant="light" styles={{ label: { textTransform: "none" } }}>
              {headline}
            </Badge>
          </Group>
          <Text size="xs" c="dimmed" lineClamp={2}>
            {message}
          </Text>
        </Stack>
        <Button size="xs" variant="light" color="yellow" style={{ flexShrink: 0 }}>
          Open →
        </Button>
      </Group>
    </Card>
  );
}

function ProjectCard({
  p,
  onOpen,
  onRemove,
}: {
  p: WorkspaceProject;
  onOpen: (id: string) => void;
  onRemove: (p: WorkspaceProject) => void;
}) {
  const meta = flowMeta(p.status);
  return (
    <Card style={{ cursor: "pointer" }} onClick={() => onOpen(p.id)}>
      <Stack gap={6}>
        <Group justify="space-between" wrap="nowrap">
          <Text fw={600} truncate>
            {p.label ?? p.id}
          </Text>
          <Group gap={4} wrap="nowrap">
            <StatusBadge status={p.status} />
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="sm"
                  aria-label="Project actions"
                  onClick={(e) => e.stopPropagation()}
                >
                  ⋯
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown onClick={(e) => e.stopPropagation()}>
                <Menu.Item color="red" onClick={() => onRemove(p)}>
                  Remove from catalog…
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
        <Text size="xs" c="dimmed" ff="monospace" truncate>
          {p.dir}
        </Text>
        {p.status?.task_label != null && (
          <Text size="sm" lineClamp={1}>
            {p.status.task_label}
          </Text>
        )}
        <Group gap={8}>
          {meta !== null && (
            <Text size="xs" c="dimmed">
              {meta}
            </Text>
          )}
          {p.bundle !== undefined && (
            <Badge size="xs" variant="default" styles={{ label: { textTransform: "none" } }}>
              {p.bundle}
            </Badge>
          )}
        </Group>
      </Stack>
    </Card>
  );
}

export function HomeView({ fleet, onOpen, onAdd }: HomeViewProps) {
  const { projects, error } = fleet;
  const [removing, setRemoving] = useState<WorkspaceProject | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const attention = needsAttention(projects);

  const doRemove = async (): Promise<void> => {
    if (removing === null) return;
    setRemoveBusy(true);
    try {
      await api("DELETE", `/workspace/projects/${encodeURIComponent(removing.id)}`);
      notifications.show({ message: `“${removing.label ?? removing.id}” removed from the catalog`, color: "green" });
      setRemoving(null);
      fleet.reload();
    } catch (err) {
      notifications.show({ message: errText(err), color: "red" });
    } finally {
      setRemoveBusy(false);
    }
  };

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="baseline">
        <Title order={2}>Projects</Title>
        {projects !== null && projects.length > 0 && (
          <Text size="sm" c="dimmed">
            {fleetCounts(projects).join(" · ")}
          </Text>
        )}
      </Group>

      {error !== null && (
        <Alert color="red" icon={<IconAlert />}>
          {errText(error)} — showing the last known state.
        </Alert>
      )}

      {attention.length > 0 && (
        <Stack gap="xs">
          <Text size="sm" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: "0.04em" }}>
            Needs you
          </Text>
          {attention.map((p) => (
            <AttentionCard key={p.id} p={p} onOpen={onOpen} />
          ))}
        </Stack>
      )}

      {projects !== null && projects.length === 0 && (
        <Card padding="xl">
          <Stack align="center" gap="sm">
            <Text c="dimmed">No projects yet.</Text>
            <Button onClick={onAdd}>Add your first project</Button>
          </Stack>
        </Card>
      )}

      {projects !== null && projects.length > 0 && (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
          {projects.map((p) => (
            <ProjectCard key={p.id} p={p} onOpen={onOpen} onRemove={setRemoving} />
          ))}
        </SimpleGrid>
      )}

      {projects === null && error === null && (
        <Text size="sm" c="dimmed">
          loading projects…
        </Text>
      )}

      <Modal
        opened={removing !== null}
        onClose={() => setRemoving(null)}
        title="Remove from catalog?"
        centered
      >
        <Stack gap="sm">
          <Text size="sm">
            “{removing?.label ?? removing?.id}” will be removed from the dashboard catalog. The
            directory and its task history on disk are not touched.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button color="red" loading={removeBusy} onClick={() => void doRemove()}>
              Remove
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
