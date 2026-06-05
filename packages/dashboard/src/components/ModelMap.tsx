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

import { useCallback, useEffect, useState } from "react";

import { api, ApiError } from "../lib/api.js";
import { validateModelRef } from "../lib/validatePair.js";
import type {
  AgentsResponse,
  BackendModelsResponse,
  LoomConfigShape,
  ProvidersResponse,
} from "../lib/types.js";
import styles from "./ModelMap.module.css";

export function ModelMap({ projectId }: { projectId: string }) {
  const [agents, setAgents] = useState<AgentsResponse | null>(null);
  const [providers, setProviders] = useState<ProvidersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  // The per-agent provider dropdown selection + a per-backend model-list cache.
  const [providerSel, setProviderSel] = useState<Record<string, string>>({});
  const [modelsByBackend, setModelsByBackend] = useState<Record<string, BackendModelsResponse>>({});
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
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Lazily fetch (and cache) a backend's model list when its dropdown is first
  // chosen. A failed/empty list is cached too — the row falls back to free-text.
  const loadModels = useCallback(
    async (backend: string): Promise<void> => {
      if (backend.length === 0 || modelsByBackend[backend] !== undefined) return;
      try {
        const r = await api<BackendModelsResponse>("GET", `/providers/${encodeURIComponent(backend)}/models`);
        setModelsByBackend((m) => ({ ...m, [backend]: r }));
      } catch {
        setModelsByBackend((m) => ({ ...m, [backend]: { backend, models: [], reason: "could not list models" } }));
      }
    },
    [modelsByBackend],
  );

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
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setSaving(null);
    }
  };

  if (error !== null) return <div className={styles.error}>{error}</div>;
  if (agents === null || providers === null) return <div className={styles.loading}>loading models…</div>;
  // Hide backends with no credential / unsupported family (`available === false`);
  // keep the unprobed ones (`null` — local / external CLI, may still work).
  const backends = providers.providers.filter((p) => p.available !== false).map((p) => p.backend);

  return (
    <div>
      <div className={styles.bundle}>
        bundle <strong>{agents.bundle}</strong> · backend <strong>{providers.backend_mode}</strong>
      </div>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>agent</th>
            <th>current</th>
            <th>set model (pick or type provider:model | tier)</th>
            <th />
          </tr>
        </thead>
        <tbody>
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
            const shownModels = search.length > 0 ? allModels.filter((m) => m.toLowerCase().includes(search)) : allModels;
            return (
              <tr key={a.agent}>
                <td className={styles.agent}>{a.agent}</td>
                <td>
                  {a.ref !== null ? (
                    <>
                      <code>{a.ref}</code>
                      <span className={styles.source}> {a.model ?? "?"} · {a.source}</span>
                    </>
                  ) : (
                    <span className={styles.source}>unset</span>
                  )}
                </td>
                <td>
                  <div className={styles.pickers}>
                    <select
                      className={styles.select}
                      value={selBackend}
                      onChange={(e) => {
                        const b = e.target.value;
                        setProviderSel((s) => ({ ...s, [a.agent]: b }));
                        void loadModels(b);
                      }}
                    >
                      <option value="">provider…</option>
                      {backends.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                    {modelList !== undefined && allModels.length > 8 && (
                      <input
                        className={styles.search}
                        type="text"
                        placeholder="filter models…"
                        value={modelSearch[a.agent] ?? ""}
                        onChange={(e) => setModelSearch((s) => ({ ...s, [a.agent]: e.target.value }))}
                      />
                    )}
                    <select
                      className={styles.select}
                      value=""
                      disabled={modelList === undefined || allModels.length === 0}
                      onChange={(e) => {
                        if (e.target.value.length > 0) setDrafts((d) => ({ ...d, [a.agent]: e.target.value }));
                      }}
                    >
                      <option value="">
                        {modelList === undefined
                          ? "model…"
                          : allModels.length === 0
                            ? "no list — type below"
                            : shownModels.length === 0
                              ? "no match"
                              : `model… (${shownModels.length})`}
                      </option>
                      {shownModels.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                  {modelList?.reason !== undefined && (
                    <div className={styles.modelNote}>{modelList.reason}</div>
                  )}
                  <input
                    className={styles.input}
                    type="text"
                    value={value}
                    placeholder={a.ref ?? "(bundle default)"}
                    onChange={(e) => setDrafts((d) => ({ ...d, [a.agent]: e.target.value }))}
                  />
                  {!hint.ok && <div className={styles.warn}>{hint.message}</div>}
                </td>
                <td>
                  <button
                    className={styles.saveBtn}
                    disabled={!editing || !hint.ok || saving === a.agent}
                    onClick={() => void save(a.agent, value)}
                  >
                    {saving === a.agent ? "…" : "save"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
