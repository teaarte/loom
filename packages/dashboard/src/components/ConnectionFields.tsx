// The connection slice of the config form — the backend mode, the CLI harness,
// and per-backend credential overrides — rendered as DROPDOWNS over live data
// rather than free text (the maintainer's "these should be dropdowns" ask). A
// purpose-built widget layered on the schema-driven form (the same pattern the
// secrets + model-map editors use), editing the SHARED config draft so there is
// one Save and no clobber.
//
// These are backend/provider/harness INFRA names (cross-bundle), not a bundle's
// agent/tier vocabulary — surfacing them does not break the domain-blind
// genericity (which is about bundle/agent/tier blindness, proven on the pure
// schema classifier). The backend list is live data (`GET /providers`); the
// harness list is a small hint set with free entry preserved; credential refs
// suggest the stored secret names (`GET /secrets`).

import { Autocomplete, Button, Group, Paper, Select, Stack, Text } from "@mantine/core";
import { useMemo } from "react";

import { useApi } from "../hooks/useApi.js";
import { useProviders } from "../hooks/useProviders.js";
import type { LoomConfigShape, SecretsResponse } from "../lib/types.js";

// Known CLI harness identifiers offered as suggestions. Free entry is preserved
// (a new harness still works) — these are infra hints, not an exhaustive list.
const HARNESS_HINTS = ["claude", "aider", "opencode"];

type CredMap = Record<string, { key_ref?: string; base_url_ref?: string }>;

export function ConnectionFields({
  draft,
  onChange,
}: {
  draft: LoomConfigShape;
  onChange: (next: LoomConfigShape) => void;
}) {
  const { data: providers } = useProviders();
  const { data: secrets } = useApi<SecretsResponse>("/secrets");

  // The backend dropdown: "auto" + every backend the deployment knows + the
  // current value (so a configured-but-unavailable backend still shows).
  const backendOptions = useMemo(() => {
    const set = new Set<string>(["auto"]);
    providers?.providers.forEach((p) => set.add(p.backend));
    if (typeof draft.backend === "string" && draft.backend.length > 0) set.add(draft.backend);
    return [...set];
  }, [providers, draft.backend]);

  // Stored secrets offered as a `secret:<name>` ref for a credential override;
  // free entry preserved so a literal or env-style value still works.
  const secretRefs = useMemo(
    () => (secrets ? Object.keys(secrets.secrets).map((n) => `secret:${n}`) : []),
    [secrets],
  );

  const creds: CredMap = draft.credentials ?? {};

  const setField = (key: "backend" | "harness", value: string): void => {
    onChange({ ...draft, [key]: value.length > 0 ? value : undefined });
  };

  const setCred = (backend: string, field: "key_ref" | "base_url_ref", value: string): void => {
    const entry = { ...(creds[backend] ?? {}) };
    if (value.length > 0) entry[field] = value;
    else delete entry[field];
    onChange({ ...draft, credentials: { ...creds, [backend]: entry } });
  };

  const removeCred = (backend: string): void => {
    const next = { ...creds };
    delete next[backend];
    onChange({ ...draft, credentials: Object.keys(next).length > 0 ? next : undefined });
  };

  const addCred = (backend: string): void => {
    if (backend.length === 0 || creds[backend] !== undefined) return;
    onChange({ ...draft, credentials: { ...creds, [backend]: {} } });
  };

  const addableBackends = backendOptions.filter((b) => b !== "auto" && creds[b] === undefined);

  return (
    <Stack gap="md">
      <Group gap="md" align="flex-end" wrap="wrap">
        <Select
          label="backend"
          description="which provider runs spawns"
          data={backendOptions}
          value={typeof draft.backend === "string" ? draft.backend : ""}
          onChange={(v) => setField("backend", v ?? "")}
          clearable
          w={220}
        />
        <Autocomplete
          label="harness"
          description="the CLI executor (type any)"
          data={HARNESS_HINTS}
          value={typeof draft.harness === "string" ? draft.harness : ""}
          onChange={(v) => setField("harness", v)}
          w={220}
        />
      </Group>

      <div>
        <Text size="sm" fw={600} mb={4}>
          credential overrides
        </Text>
        <Text size="xs" c="dimmed" mb="xs">
          Most backends resolve a key by convention (e.g. ANTHROPIC_API_KEY). Add an override only to point
          a backend at a different secret.
        </Text>
        <Stack gap="xs">
          {Object.keys(creds).length === 0 && (
            <Text size="xs" c="dimmed">
              none
            </Text>
          )}
          {Object.keys(creds).map((backend) => (
            <Paper key={backend} withBorder radius="md" p="xs">
              <Group justify="space-between" mb={4}>
                <Text fw={600} size="sm">
                  {backend}
                </Text>
                <Button size="compact-xs" variant="subtle" color="red" onClick={() => removeCred(backend)}>
                  remove
                </Button>
              </Group>
              <Group gap="md" wrap="wrap">
                <Autocomplete
                  label="key_ref"
                  size="xs"
                  data={secretRefs}
                  value={creds[backend]?.key_ref ?? ""}
                  onChange={(v) => setCred(backend, "key_ref", v)}
                  w={260}
                />
                <Autocomplete
                  label="base_url_ref"
                  size="xs"
                  data={secretRefs}
                  value={creds[backend]?.base_url_ref ?? ""}
                  onChange={(v) => setCred(backend, "base_url_ref", v)}
                  w={260}
                />
              </Group>
            </Paper>
          ))}
          {addableBackends.length > 0 && (
            <Select
              placeholder="+ add a credential override for…"
              data={addableBackends}
              value={null}
              onChange={(v) => v !== null && addCred(v)}
              size="xs"
              w={320}
            />
          )}
        </Stack>
      </div>
    </Stack>
  );
}
