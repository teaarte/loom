import {
  ActionIcon,
  AppShell,
  Badge,
  Box,
  Burger,
  Button,
  Group,
  Indicator,
  NavLink,
  PasswordInput,
  Popover,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useState } from "react";

import { IconGear, IconGrid, IconKey, IconPlug, IconPlus } from "./components/icons.js";
import { Onboarding } from "./components/Onboarding.js";
import { useApi } from "./hooks/useApi.js";
import { needsAttention, useFleet } from "./hooks/useFleet.js";
import { getToken, setToken } from "./lib/api.js";
import { useRoute, type Route } from "./lib/router.js";
import { AddProjectView } from "./views/AddProjectView.js";
import { HomeView } from "./views/HomeView.js";
import { ProjectDetail } from "./views/ProjectDetail.js";
import { ProvidersView } from "./views/ProvidersView.js";
import { SettingsView } from "./views/SettingsView.js";

// A localhost-reachability pill: `/health` needs no token, so green means the
// control plane is up. An API-auth problem (missing/wrong token) surfaces as an
// error inside the authed views, not here.
function ConnStatus() {
  const health = useApi<{ ok: boolean }>("/health", 5000);
  const up = health.data?.ok === true && health.error === null;
  return (
    <Group gap={6} wrap="nowrap">
      <Indicator color={up ? "green" : "red"} size={9} processing={up} />
      <Text size="xs" c="dimmed" visibleFrom="xs">
        {up ? "connected" : "offline"}
      </Text>
    </Group>
  );
}

// The bearer-token control, tucked into a header popover — set once, then out
// of the way (localhost-trust deployments never need it).
function TokenControl({ onSaved }: { onSaved: () => void }) {
  const [opened, setOpened] = useState(false);
  const [value, setValue] = useState(getToken());

  const save = (): void => {
    setToken(value.trim());
    setOpened(false);
    notifications.show({ message: "API token saved", color: "green" });
    onSaved();
  };

  return (
    <Popover opened={opened} onChange={setOpened} width={280} position="bottom-end" withArrow>
      <Popover.Target>
        <ActionIcon
          variant={getToken().length > 0 ? "light" : "subtle"}
          color="gray"
          aria-label="API token"
          onClick={() => setOpened((o) => !o)}
        >
          <IconKey />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Text size="sm" fw={600}>
            API token
          </Text>
          <PasswordInput
            size="xs"
            placeholder="none — localhost trust"
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
          <Button size="xs" onClick={save}>
            Save
          </Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

export function App() {
  const { route, navigate } = useRoute();
  const fleet = useFleet();
  const [navOpened, { toggle: toggleNav, close: closeNav }] = useDisclosure(false);
  // Bump to nudge the onboarding detector to re-run after an action that may
  // complete a step (without a global data layer).
  const [refreshKey, setRefreshKey] = useState(0);

  const go = (to: Route): void => {
    closeNav();
    navigate(to);
  };

  const refresh = (): void => {
    fleet.reload();
    setRefreshKey((k) => k + 1);
  };

  const attention = needsAttention(fleet.projects).length;

  return (
    <AppShell
      header={{ height: 52 }}
      navbar={{ width: 220, breakpoint: "sm", collapsed: { mobile: !navOpened } }}
      padding="lg"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={navOpened} onClick={toggleNav} hiddenFrom="sm" size="sm" />
            <Title
              order={4}
              style={{ cursor: "pointer", letterSpacing: "-0.02em" }}
              onClick={() => go({ name: "home" })}
            >
              🧵 loom
            </Title>
          </Group>
          <Group gap="sm" wrap="nowrap">
            <ConnStatus />
            <TokenControl onSaved={refresh} />
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        <Stack gap={4} h="100%">
          <NavLink
            label="Projects"
            leftSection={<IconGrid />}
            rightSection={
              attention > 0 ? (
                <Badge size="sm" color="yellow" variant="filled" circle>
                  {attention}
                </Badge>
              ) : undefined
            }
            active={route.name === "home" || route.name === "project"}
            onClick={() => go({ name: "home" })}
          />
          <NavLink
            label="Settings"
            leftSection={<IconGear />}
            active={route.name === "settings"}
            onClick={() => go({ name: "settings" })}
          />
          <NavLink
            label="Providers"
            leftSection={<IconPlug />}
            active={route.name === "providers"}
            onClick={() => go({ name: "providers" })}
          />
          <Box flex={1} />
          <Button
            variant="light"
            leftSection={<IconPlus />}
            onClick={() => go({ name: "add" })}
          >
            Add project
          </Button>
        </Stack>
      </AppShell.Navbar>

      <AppShell.Main>
        {route.name === "home" && (
          <>
            <Onboarding key={refreshKey} onChanged={refresh} />
            <HomeView
              fleet={fleet}
              onOpen={(id) => go({ name: "project", id })}
              onAdd={() => go({ name: "add" })}
            />
          </>
        )}
        {route.name === "project" && (
          <ProjectDetailRoute
            id={route.id}
            fleet={fleet}
            onBack={() => go({ name: "home" })}
            onOpenSettings={() => go({ name: "settings", tab: "models" })}
          />
        )}
        {route.name === "settings" && <SettingsView {...(route.tab !== undefined ? { initialTab: route.tab } : {})} />}
        {route.name === "providers" && <ProvidersView />}
        {route.name === "add" && (
          <AddProjectView
            onAdded={() => {
              refresh();
              go({ name: "home" });
            }}
          />
        )}
      </AppShell.Main>
    </AppShell>
  );
}

// Resolve a deep-linked project route against the shared fleet snapshot — the
// detail header needs dir/label before the first SSE tick, and a pasted URL
// (or a page reload) arrives without them.
function ProjectDetailRoute({
  id,
  fleet,
  onBack,
  onOpenSettings,
}: {
  id: string;
  fleet: ReturnType<typeof useFleet>;
  onBack: () => void;
  onOpenSettings: () => void;
}) {
  const found = fleet.projects?.find((p) => p.id === id);
  if (fleet.projects === null) {
    return (
      <Text c="dimmed" size="sm">
        loading project…
      </Text>
    );
  }
  if (found === undefined) {
    return (
      <Stack gap="sm" align="flex-start">
        <Text c="red" size="sm">
          Project “{id}” isn’t in the catalog on this server.
        </Text>
        <Button variant="light" size="xs" onClick={onBack}>
          ← all projects
        </Button>
      </Stack>
    );
  }
  return (
    <ProjectDetail
      projectId={found.id}
      dir={found.dir}
      {...(found.label !== undefined ? { label: found.label } : {})}
      onBack={onBack}
      onOpenSettings={onOpenSettings}
    />
  );
}
