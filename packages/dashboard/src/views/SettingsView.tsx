// Global settings, organised as tabs: Config (the connection dropdowns + the
// schema-driven form for the rest), Models (the bundle model-map editor), and
// Secrets (the write-only secret store). The schema-driven form is generated
// from `GET /config/schema` (so it edits any bundle's config with no hardcoded
// field names) over the masked `GET /config` value, and writes the whole
// document with `PUT /config` (the server validates + reconciles masked
// secrets). The connection keys (backend / harness / credentials) get the
// purpose-built `ConnectionFields` dropdowns layered on, editing the SAME draft.
// Secrets are listed masked (`GET /secrets`) and set write-only — a raw value is
// never shown.

import {
  Anchor,
  Button,
  Group,
  Paper,
  PasswordInput,
  Stack,
  Tabs,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ConnectionFields } from "../components/ConnectionFields.js";
import { ModelMap } from "../components/ModelMap.js";
import { pruneEmpty, SchemaField } from "../components/SchemaForm.js";
import { api, ApiError, errText } from "../lib/api.js";
import { classify } from "../lib/schemaForm.js";
import type {
  JsonSchema,
  LoomConfigShape,
  ProjectListing,
  SecretsResponse,
  WorkspaceResponse,
} from "../lib/types.js";

// The connection keys the `ConnectionFields` widget owns — the generic form skips
// them so they are edited once (as dropdowns) on the shared draft, not twice.
const CONNECTION_KEYS = new Set(["backend", "harness", "credentials"]);

export function SettingsView({ initialTab }: { initialTab?: string } = {}) {
  return (
    <div>
      <Title order={2} mb="md">
        Settings
      </Title>
      <Tabs defaultValue={initialTab ?? "config"} keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="config">Config</Tabs.Tab>
          <Tabs.Tab value="models">Models</Tabs.Tab>
          <Tabs.Tab value="secrets">Secrets</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="config" pt="md">
          <ConfigForm />
        </Tabs.Panel>
        <Tabs.Panel value="models" pt="md">
          <Text size="sm" c="dimmed" mb="sm">
            Bind each bundle agent to a model (the same <code>bundles[…].agents</code> map{" "}
            <code>loom models set</code> writes). Pick a provider + model from the live list, or type a{" "}
            <code>provider:model | tier</code> ref.
          </Text>
          <ModelMapSection />
        </Tabs.Panel>
        <Tabs.Panel value="secrets" pt="md">
          <Text size="sm" c="dimmed" mb="sm">
            Stored machine-local (chmod 600) and referenced from config as{" "}
            <code>secret:&lt;name&gt;</code>. Values are write-only — set a new value to replace; existing
            values show masked.
          </Text>
          <SecretsWidget />
        </Tabs.Panel>
      </Tabs>
    </div>
  );
}

// The model-map editor in global Settings. The roster is read off a project's
// loaded bundle (`/projects/:id/agents`), but the write target is the GLOBAL
// config, so editing it here is identical to editing it from any project's
// detail view. It borrows the first cataloged/supervised project to source the
// roster; with none, it points the operator at adding one.
function ModelMapSection() {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let id: string | undefined;
        try {
          const ws = await api<WorkspaceResponse>("GET", "/workspace");
          id = ws.projects[0]?.id;
        } catch (err) {
          if (err instanceof ApiError && err.status === 501) {
            const live = await api<ProjectListing[]>("GET", "/projects");
            id = live[0]?.id;
          } else throw err;
        }
        if (cancelled) return;
        if (id === undefined) setNote("Add a project to edit its bundle's model map.");
        else setProjectId(id);
      } catch (err) {
        if (!cancelled) setNote(errText(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (projectId !== null) return <ModelMap projectId={projectId} />;
  return (
    <Text size="sm" c="dimmed">
      {note ?? "loading roster…"}
    </Text>
  );
}

function ConfigForm() {
  const [schema, setSchema] = useState<JsonSchema | null>(null);
  const [draft, setDraft] = useState<LoomConfigShape | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([
        api<JsonSchema>("GET", "/config/schema"),
        api<LoomConfigShape>("GET", "/config"),
      ]);
      setSchema(s);
      setDraft(c);
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The generic (non-connection) top-level fields, in schema order.
  const genericFields = useMemo(() => {
    if (schema === null) return [];
    const root = classify(schema);
    return root.kind === "object" ? root.fields.filter((f) => !CONNECTION_KEYS.has(f.key)) : [];
  }, [schema]);

  const save = async (): Promise<void> => {
    if (draft === null) return;
    setSaving(true);
    setMsg(null);
    try {
      const body = (pruneEmpty(draft) as LoomConfigShape | undefined) ?? {};
      const stored = await api<LoomConfigShape>("PUT", "/config", body);
      setDraft(stored);
      setMsg("saved");
    } catch (err) {
      setMsg(errText(err));
    } finally {
      setSaving(false);
    }
  };

  if (error !== null) {
    return (
      <Text c="red" size="sm">
        {error}
      </Text>
    );
  }
  if (schema === null || draft === null) {
    return (
      <Text size="sm" c="dimmed">
        loading config…
      </Text>
    );
  }

  const setField = (key: string, next: unknown): void => {
    setDraft((d) => {
      const copy = { ...(d ?? {}) };
      if (next === undefined) delete copy[key];
      else copy[key] = next;
      return copy;
    });
  };

  return (
    <Stack gap="lg">
      <ConnectionFields draft={draft} onChange={(next) => setDraft(next)} />
      {genericFields.map((f) => (
        <SchemaField
          key={f.key}
          node={f.node}
          label={f.key}
          value={draft[f.key]}
          onChange={(next) => setField(f.key, next)}
        />
      ))}
      <Group gap="sm" align="center">
        <Button onClick={() => void save()} loading={saving}>
          save config
        </Button>
        <Anchor component="button" type="button" onClick={() => void load()}>
          revert
        </Anchor>
        {msg !== null && (
          <Text size="sm" c="dimmed">
            {msg}
          </Text>
        )}
      </Group>
    </Stack>
  );
}

function SecretsWidget() {
  const [secrets, setSecrets] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api<SecretsResponse>("GET", "/secrets");
      setSecrets(r.secrets);
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const store = async (name: string): Promise<void> => {
    const value = values[name] ?? "";
    if (value.length === 0) return;
    setBusy(name);
    try {
      await api("PUT", `/secrets/${encodeURIComponent(name)}`, { value });
      setValues((v) => {
        const next = { ...v };
        delete next[name];
        return next;
      });
      await load();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(null);
    }
  };

  const addNew = async (): Promise<void> => {
    const name = newName.trim();
    if (name.length === 0) return;
    await store(name);
    setNewName("");
  };

  if (error !== null) {
    return (
      <Text c="red" size="sm">
        {error}
      </Text>
    );
  }
  if (secrets === null) {
    return (
      <Text size="sm" c="dimmed">
        loading secrets…
      </Text>
    );
  }

  const names = Object.keys(secrets);

  return (
    <Stack gap="sm">
      {names.length === 0 && (
        <Text size="sm" c="dimmed">
          no secrets stored yet
        </Text>
      )}
      {names.map((name) => (
        <Group key={name} gap="sm" align="flex-end" wrap="wrap">
          <Text size="sm" fw={600} w={200} style={{ wordBreak: "break-all" }}>
            {name}
          </Text>
          <Text size="sm" c="dimmed" ff="monospace">
            {secrets[name]}
          </Text>
          <PasswordInput
            placeholder="new value"
            value={values[name] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [name]: e.currentTarget.value }))}
            w={220}
          />
          <Button
            size="compact-sm"
            loading={busy === name}
            disabled={(values[name] ?? "").length === 0}
            onClick={() => void store(name)}
          >
            update
          </Button>
        </Group>
      ))}
      <Paper withBorder radius="md" p="sm">
        <Text size="sm" fw={600} mb="xs">
          add a secret
        </Text>
        <Group gap="sm" align="flex-end" wrap="wrap">
          <TextInput
            label="name"
            placeholder="ANTHROPIC_API_KEY"
            value={newName}
            onChange={(e) => setNewName(e.currentTarget.value)}
            w={260}
          />
          <PasswordInput
            label="value"
            placeholder="value"
            value={values[newName] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [newName]: e.currentTarget.value }))}
            w={260}
          />
          <Button disabled={newName.trim().length === 0} onClick={() => void addNew()}>
            add
          </Button>
        </Group>
      </Paper>
    </Stack>
  );
}
