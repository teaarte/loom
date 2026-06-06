// Providers: each backend, the provider families it can run, a best-effort
// availability signal the server knows WITHOUT spawning, and — new here — an
// inline credential setter so a key is set where the operator sees it is missing
// (the write-only secrets store, surfaced per provider). The configured backend
// mode is highlighted. These are cross-bundle INFRA names, not a bundle's domain.

import { Badge, Button, Group, Paper, PasswordInput, Stack, Text, TextInput, Title } from "@mantine/core";
import { useState } from "react";

import { useProviders } from "../hooks/useProviders.js";
import { api, errText } from "../lib/api.js";
import type { ProviderInfo } from "../lib/types.js";

// Conventional secret name per API-key/local backend — a CONVENIENCE prefill for
// the inline setter (it mirrors the server's resolution convention; the name
// stays editable, so a drift is correctable, and the Settings → Secrets tab is
// the generic fallback for any backend). `claude-code` is OAuth — no key here.
const PROVIDER_SECRET: Record<string, { secret: string; valueLabel: string }> = {
  "anthropic-sdk": { secret: "ANTHROPIC_API_KEY", valueLabel: "API key" },
  openrouter: { secret: "OPENROUTER_API_KEY", valueLabel: "API key" },
  openai: { secret: "OPENAI_API_KEY", valueLabel: "API key" },
  ollama: { secret: "OLLAMA_HOST", valueLabel: "base URL" },
};

function availabilityBadge(available: boolean | null): { color: string; text: string } {
  if (available === true) return { color: "green", text: "available" };
  if (available === false) return { color: "red", text: "unavailable" };
  return { color: "gray", text: "not probed" };
}

export function ProvidersView() {
  const { data, error, reload } = useProviders(10000);

  return (
    <div>
      <Title order={2} mb="md">
        Providers
      </Title>
      {error && (
        <Text c="red" size="sm" mb="sm">
          {errText(error)}
        </Text>
      )}
      {data && (
        <>
          <Text size="sm" c="dimmed" mb="sm">
            backend mode: <strong>{data.backend_mode}</strong>
            {data.backend_mode === "auto" && " — auto picks a compatible backend per spawn"}
          </Text>
          <Stack gap="sm">
            {data.providers.map((p) => (
              <ProviderCard key={p.backend} provider={p} active={p.backend === data.backend_mode} onSaved={reload} />
            ))}
          </Stack>
        </>
      )}
    </div>
  );
}

function ProviderCard({
  provider,
  active,
  onSaved,
}: {
  provider: ProviderInfo;
  active: boolean;
  onSaved: () => void;
}) {
  const av = availabilityBadge(provider.available);
  return (
    <Paper withBorder radius="md" p="sm">
      <Group justify="space-between" align="center" wrap="wrap" mb={6}>
        <Group gap="xs" align="center">
          <Text fw={600}>{provider.backend}</Text>
          {active && (
            <Badge size="xs" variant="light" color="loomBlue">
              selected
            </Badge>
          )}
          <Badge size="sm" variant="light" color={av.color}>
            {av.text}
          </Badge>
        </Group>
        <Text size="xs" c="dimmed">
          {provider.families.join(", ")}
        </Text>
      </Group>
      {provider.reason && (
        <Text size="xs" c="dimmed" mb={6}>
          {provider.reason}
        </Text>
      )}
      <ProviderKey backend={provider.backend} onSaved={onSaved} />
    </Paper>
  );
}

// Set a backend's credential inline. The secret name defaults to the convention
// (editable); the value is write-only (a PUT /secrets/:name). On save the
// providers list reloads, so an availability signal flips without a refresh.
function ProviderKey({ backend, onSaved }: { backend: string; onSaved: () => void }) {
  const conv = PROVIDER_SECRET[backend];
  const [secretName, setSecretName] = useState(conv?.secret ?? "");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (backend === "claude-code") {
    return (
      <Text size="xs" c="dimmed">
        Signs in via the Claude Code CLI (OAuth) — no API key to set here.
      </Text>
    );
  }

  const save = async (): Promise<void> => {
    const name = secretName.trim();
    if (name.length === 0 || value.length === 0) {
      setMsg("enter a secret name and value");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await api("PUT", `/secrets/${encodeURIComponent(name)}`, { value });
      setValue("");
      setMsg("saved ✓");
      onSaved();
    } catch (err) {
      setMsg(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Group gap="sm" align="flex-end" wrap="wrap">
      <TextInput
        label="secret name"
        size="xs"
        value={secretName}
        onChange={(e) => setSecretName(e.currentTarget.value)}
        placeholder="e.g. OPENROUTER_API_KEY"
        w={220}
      />
      <PasswordInput
        label={conv?.valueLabel ?? "value"}
        size="xs"
        value={value}
        onChange={(e) => setValue(e.currentTarget.value)}
        placeholder="paste, then save"
        w={240}
      />
      <Button size="compact-sm" loading={busy} onClick={() => void save()}>
        save
      </Button>
      {msg !== null && (
        <Text size="xs" c="dimmed">
          {msg}
        </Text>
      )}
    </Group>
  );
}
