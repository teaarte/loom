// The model-map editor — bind a bundle's agents to models, the UI face of
// `loom models set`. The roster + each agent's CURRENT binding comes from
// `GET /projects/:id/agents` (names are DATA off the loaded bundle); the
// allowable provider families come from `GET /providers`. Before a write it runs
// the CLIENT-side `validateModelRef` mirror so an incompatible `(backend, model)`
// pair is flagged inline — the server re-checks on `PUT /config` and is the
// authority.
//
// It writes the GLOBAL config (the same store `loom models set` writes):
// `bundles[<bundle>].agents[<agent>]`. The masked config is round-tripped whole
// — the server reconciles any masked secret back to its stored literal.

import { useCallback, useEffect, useState } from "react";

import { api, ApiError } from "../lib/api.js";
import { validateModelRef } from "../lib/validatePair.js";
import type { AgentsResponse, LoomConfigShape, ProvidersResponse } from "../lib/types.js";
import styles from "./ModelMap.module.css";

export function ModelMap({ projectId }: { projectId: string }) {
  const [agents, setAgents] = useState<AgentsResponse | null>(null);
  const [providers, setProviders] = useState<ProvidersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

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
            <th>set model (provider:model | tier)</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {agents.agents.map((a) => {
            const draft = drafts[a.agent];
            const editing = draft !== undefined;
            const value = editing ? draft : (a.ref ?? "");
            const hint = value.trim().length > 0 ? validateModelRef(providers.backend_mode, providers.providers, value) : { ok: true as const };
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
