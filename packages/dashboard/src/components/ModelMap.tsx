// The model-map editor — bind a bundle's agents to models, the UI face of
// `loom models set`. The roster + each agent's CURRENT binding comes from
// `GET /projects/:id/agents` (names are DATA off the loaded bundle); the
// allowable provider families come from `GET /providers`. Each row offers a
// provider dropdown + a model dropdown (the live list from
// `GET /providers/:backend/models`) that FILLS a free-text ref — the free text
// is always the source of truth, so a backend with no live list still works.
// Before a write it runs the CLIENT-side `validateModelRef` mirror so an
// incompatible `(backend, model)` pair is flagged inline — the server re-checks
// on `PUT /config` and is the authority.
//
// It writes the GLOBAL config (the same store `loom models set` writes):
// `bundles[<bundle>].agents[<agent>]`. The masked config is round-tripped whole
// — the server reconciles any masked secret back to its stored literal.

import {
  Button,
  Code,
  Group,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { useCallback, useEffect, useState } from "react";

import { useModelList } from "../hooks/useModelList.js";
import { api, errText } from "../lib/api.js";
import { validateModelRef } from "../lib/validatePair.js";
import type { AgentsResponse, LoomConfigShape, ProvidersResponse } from "../lib/types.js";

export function ModelMap({ projectId }: { projectId: string }) {
  const [agents, setAgents] = useState<AgentsResponse | null>(null);
  const [providers, setProviders] = useState<ProvidersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  // The per-agent provider dropdown selection.
  const [providerSel, setProviderSel] = useState<Record<string, string>>({});
  // The per-backend model-list cache + lazy loader (shared hook).
  const { modelsByBackend, loadModels } = useModelList();
  // Per-agent model-dropdown search (OpenRouter lists hundreds — a substring
  // filter keeps the picker usable without a heavier combobox).
  const [modelSearch, setModelSearch] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    try {
      const [a, p] = await Promise.all([
        api<AgentsResponse>("GET", `/projects/${encodeURIComponent(projectId)}/agents`),
        api<ProvidersResponse>("GET", "/providers"),
      ]);
      setAgents(a);
      setProviders(p);
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = async (agent: string, ref: string): Promise<void> => {
    if (agents === null) return;
    setSaving(agent);
    try {
      // Merge into the global config under this bundle's agent map; an empty
      // ref clears the override (falls back to the bundle default).
      const cfg = await api<LoomConfigShape>("GET", "/config");
      const bundles = { ...(cfg.bundles ?? {}) };
      const bundleCfg = bundles[agents.bundle] ?? {};
      const agentMap = { ...(bundleCfg.agents ?? {}) };
      if (ref.trim().length === 0) delete agentMap[agent];
      else agentMap[agent] = ref.trim();
      bundles[agents.bundle] = { ...bundleCfg, agents: agentMap };
      await api("PUT", "/config", { ...cfg, bundles });
      setDrafts((d) => {
        const next = { ...d };
        delete next[agent];
        return next;
      });
      await reload();
    } catch (err) {
      setError(errText(err));
    } finally {
      setSaving(null);
    }
  };

  if (error !== null)
    return (
      <Text size="sm" c="red">
        {error}
      </Text>
    );
  if (agents === null || providers === null)
    return (
      <Text size="sm" c="dimmed">
        loading models…
      </Text>
    );
  // Hide backends with no credential / unsupported family (`available === false`);
  // keep the unprobed ones (`null` — local / external CLI, may still work).
  const backends = providers.providers.filter((p) => p.available !== false).map((p) => p.backend);

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        bundle{" "}
        <Text span fw={600} c="var(--mantine-color-text)">
          {agents.bundle}
        </Text>{" "}
        · backend{" "}
        <Text span fw={600} c="var(--mantine-color-text)">
          {providers.backend_mode}
        </Text>
      </Text>
      <Table.ScrollContainer minWidth={760}>
        <Table verticalSpacing="sm" highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Agent</Table.Th>
              <Table.Th>Current</Table.Th>
              <Table.Th>Set model (pick, or type provider:model | tier)</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {agents.agents.map((a) => {
              const draft = drafts[a.agent];
              const editing = draft !== undefined;
              const value = editing ? draft : (a.ref ?? "");
              const hint =
                value.trim().length > 0
                  ? validateModelRef(providers.backend_mode, providers.providers, value)
                  : { ok: true as const };
              const selBackend = providerSel[a.agent] ?? "";
              const modelList = selBackend.length > 0 ? modelsByBackend[selBackend] : undefined;
              const search = (modelSearch[a.agent] ?? "").trim().toLowerCase();
              const allModels = modelList?.models ?? [];
              const shownModels =
                search.length > 0 ? allModels.filter((m) => m.toLowerCase().includes(search)) : allModels;
              return (
                <Table.Tr key={a.agent}>
                  <Table.Td>
                    <Text size="sm" fw={600}>
                      {a.agent}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {a.ref !== null ? (
                      <Stack gap={2}>
                        <Code>{a.ref}</Code>
                        <Text size="xs" c="dimmed">
                          {a.model ?? "?"} · {a.source}
                        </Text>
                      </Stack>
                    ) : (
                      <Text size="xs" c="dimmed">
                        unset
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Stack gap={6}>
                      <Group gap={6} wrap="wrap">
                        <Select
                          size="xs"
                          w={170}
                          placeholder="provider…"
                          data={backends}
                          value={selBackend.length > 0 ? selBackend : null}
                          onChange={(v) => {
                            const b = v ?? "";
                            setProviderSel((s) => ({ ...s, [a.agent]: b }));
                            if (b.length > 0) void loadModels(b);
                          }}
                        />
                        {modelList !== undefined && allModels.length > 8 && (
                          <TextInput
                            size="xs"
                            w={150}
                            placeholder="filter models…"
                            value={modelSearch[a.agent] ?? ""}
                            onChange={(e) =>
                              setModelSearch((s) => ({ ...s, [a.agent]: e.currentTarget.value }))
                            }
                          />
                        )}
                        <Select
                          size="xs"
                          w={230}
                          placeholder={
                            modelList === undefined
                              ? "model…"
                              : allModels.length === 0
                                ? "no list — type below"
                                : shownModels.length === 0
                                  ? "no match"
                                  : `model… (${shownModels.length})`
                          }
                          data={shownModels}
                          disabled={modelList === undefined || allModels.length === 0}
                          value={null}
                          onChange={(v) => {
                            if (v !== null && v.length > 0)
                              setDrafts((d) => ({ ...d, [a.agent]: v }));
                          }}
                        />
                      </Group>
                      {modelList?.reason !== undefined && (
                        <Text size="xs" c="dimmed">
                          {modelList.reason}
                        </Text>
                      )}
                      <TextInput
                        size="xs"
                        ff="monospace"
                        value={value}
                        placeholder={a.ref ?? "(bundle default)"}
                        onChange={(e) => setDrafts((d) => ({ ...d, [a.agent]: e.currentTarget.value }))}
                      />
                      {!hint.ok && (
                        <Text size="xs" c="yellow.8">
                          {hint.message}
                        </Text>
                      )}
                    </Stack>
                  </Table.Td>
                  <Table.Td>
                    <Button
                      size="xs"
                      variant="light"
                      disabled={!editing || !hint.ok || saving === a.agent}
                      loading={saving === a.agent}
                      onClick={() => void save(a.agent, value)}
                    >
                      Save
                    </Button>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  );
}
