// A detect-once, dismissible onboarding panel. On first load it probes
// `GET /providers` (is any backend available?) and `GET /workspace` (any project
// yet?); if a backend is usable AND a project exists, it renders nothing. It
// NEVER blocks the rest of the UI and the headless path never reaches it (there
// is no UI there). A purely-visual "shown once" flag lives in localStorage — it
// is the only client-only state, and it is a preference, not control state.
//
// The panel guides three steps over the SAME routes the views use: pick a
// backend (`PUT /config`), optionally store a credential secret
// (`PUT /secrets/:name`), and add a first project (`POST /workspace/projects`,
// with the same folder browser the Add view uses). Backend names are infra DATA
// from `/providers` — nothing here is hardcoded.

import {
  Button,
  Card,
  Collapse,
  Group,
  PasswordInput,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useCallback, useEffect, useState } from "react";

import { api, errText } from "../lib/api.js";
import type { LoomConfigShape, ProvidersResponse, WorkspaceResponse } from "../lib/types.js";
import { FolderBrowser } from "./FolderBrowser.js";

const DISMISS_KEY = "loom_onboarded";

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}
function setDismissed(): void {
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* private-mode storage — the panel simply reappears next load */
  }
}

function Step({ n, label, children }: { n: number; label: string; children: React.ReactNode }) {
  return (
    <Stack gap={6}>
      <Text size="sm" fw={600}>
        {n} · {label}
      </Text>
      {children}
    </Stack>
  );
}

export function Onboarding({ onChanged }: { onChanged: () => void }) {
  const [hidden, setHidden] = useState(dismissed());
  const [needed, setNeeded] = useState<boolean | null>(null);
  const [providers, setProviders] = useState<ProvidersResponse | null>(null);

  const [backend, setBackend] = useState("");
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [dir, setDir] = useState("");
  const [browse, setBrowse] = useState(false);

  const detect = useCallback(async () => {
    try {
      const [prov, ws] = await Promise.all([
        api<ProvidersResponse>("GET", "/providers"),
        api<WorkspaceResponse>("GET", "/workspace"),
      ]);
      setProviders(prov);
      const hasBackend = prov.providers.some((p) => p.available === true);
      const hasProject = ws.projects.length > 0;
      setNeeded(!hasBackend || !hasProject);
    } catch {
      // The config API may be disabled (501) or unauthenticated — nothing to
      // onboard against, so stay quiet.
      setNeeded(false);
    }
  }, []);

  useEffect(() => {
    if (!hidden) void detect();
  }, [hidden, detect]);

  if (hidden || needed !== true) return null;

  const dismiss = (): void => {
    setDismissed();
    setHidden(true);
  };

  const fail = (err: unknown): void => {
    notifications.show({ message: errText(err), color: "red" });
  };

  const saveBackend = async (): Promise<void> => {
    if (backend.length === 0) return;
    try {
      const cfg = await api<LoomConfigShape>("GET", "/config");
      await api("PUT", "/config", { ...cfg, backend });
      notifications.show({ message: `Backend set to ${backend}`, color: "green" });
      onChanged();
      void detect();
    } catch (err) {
      fail(err);
    }
  };

  const saveSecret = async (): Promise<void> => {
    if (secretName.trim().length === 0 || secretValue.length === 0) return;
    try {
      await api("PUT", `/secrets/${encodeURIComponent(secretName.trim())}`, { value: secretValue });
      setSecretValue("");
      notifications.show({ message: `Stored secret ${secretName.trim()}`, color: "green" });
      void detect();
    } catch (err) {
      fail(err);
    }
  };

  const addProject = async (): Promise<void> => {
    if (dir.trim().length === 0) return;
    try {
      await api("POST", "/workspace/projects", { dir: dir.trim() });
      notifications.show({ message: `Added ${dir.trim()}`, color: "green" });
      onChanged();
      void detect();
    } catch (err) {
      fail(err);
    }
  };

  return (
    <Card mb="lg" style={{ borderColor: "var(--mantine-primary-color-filled)" }}>
      <Stack gap="md">
        <Group justify="space-between" align="baseline">
          <Text fw={700}>Welcome to loom</Text>
          <Button variant="subtle" size="compact-xs" color="gray" onClick={dismiss}>
            dismiss
          </Button>
        </Group>
        <Text size="sm" c="dimmed">
          A couple of one-time steps to get a task running. You can skip any of these and configure
          them later in Settings.
        </Text>

        <Step n={1} label="Choose a backend">
          <Group gap="sm" align="flex-end" wrap="wrap">
            <Select
              size="xs"
              w={300}
              placeholder="pick a backend"
              data={(providers?.providers ?? []).map((p) => ({
                value: p.backend,
                label: `${p.backend}${p.available === true ? " — available" : p.available === false ? " — needs setup" : ""}`,
              }))}
              value={backend.length > 0 ? backend : null}
              onChange={(v) => setBackend(v ?? "")}
            />
            <Button size="xs" disabled={backend.length === 0} onClick={() => void saveBackend()}>
              Set
            </Button>
          </Group>
        </Step>

        <Step n={2} label="Credential (if the backend needs an API key)">
          <Group gap="sm" align="flex-end" wrap="wrap">
            <TextInput
              size="xs"
              w={220}
              placeholder="secret name"
              value={secretName}
              onChange={(e) => setSecretName(e.currentTarget.value)}
            />
            <PasswordInput
              size="xs"
              w={260}
              placeholder="value (write-only)"
              value={secretValue}
              onChange={(e) => setSecretValue(e.currentTarget.value)}
            />
            <Button
              size="xs"
              disabled={secretName.trim().length === 0 || secretValue.length === 0}
              onClick={() => void saveSecret()}
            >
              Store
            </Button>
          </Group>
        </Step>

        <Step n={3} label="Add your first project">
          <Group gap="sm" align="flex-end" wrap="wrap">
            <TextInput
              size="xs"
              w={360}
              placeholder="/abs/path/to/project"
              value={dir}
              onChange={(e) => setDir(e.currentTarget.value)}
            />
            <Button size="xs" variant="default" onClick={() => setBrowse((b) => !b)}>
              {browse ? "Hide browser" : "Browse…"}
            </Button>
            <Button size="xs" disabled={dir.trim().length === 0} onClick={() => void addProject()}>
              Add
            </Button>
          </Group>
          <Collapse expanded={browse}>
            <FolderBrowser onPick={(p) => setDir(p)} />
          </Collapse>
        </Step>
      </Stack>
    </Card>
  );
}
