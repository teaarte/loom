// Global settings: the schema-driven config form + the write-only secrets
// widget. The form is generated from `GET /config/schema` (so it edits any
// bundle's config with no hardcoded field names) over the masked `GET /config`
// value, and writes the whole document with `PUT /config` (the server validates
// + reconciles masked secrets). Secrets are listed masked (`GET /secrets`) and
// set write-only (`PUT /secrets/:name`) — a raw value is never shown.

import { useCallback, useEffect, useState } from "react";

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
import styles from "./SettingsView.module.css";

export function SettingsView() {
  return (
    <div>
      <h1>Settings</h1>
      <ConfigForm />
      <h2>models</h2>
      <p className={styles.note}>
        Bind each bundle agent to a model (the same <code>bundles[…].agents</code> map{" "}
        <code>loom models set</code> writes). Pick a provider + model from the live list, or type a
        <code> provider:model | tier</code> ref.
      </p>
      <ModelMapSection />
      <h2>secrets</h2>
      <p className={styles.note}>
        Stored machine-local (chmod 600) and referenced from config as <code>secret:&lt;name&gt;</code>.
        Values are write-only — set a new value to replace; existing values show masked.
      </p>
      <SecretsWidget />
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
  return <div className={styles.note}>{note ?? "loading roster…"}</div>;
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

  if (error !== null) return <div className={styles.error}>{error}</div>;
  if (schema === null || draft === null) return <div className={styles.loading}>loading config…</div>;

  return (
    <div>
      <SchemaField node={classify(schema)} value={draft} onChange={(next) => setDraft((next ?? {}) as LoomConfigShape)} />
      <div className={styles.actions}>
        <button className={styles.btn} disabled={saving} onClick={() => void save()}>
          {saving ? "saving…" : "save config"}
        </button>
        <button className={styles.linkBtn} onClick={() => void load()}>
          revert
        </button>
        {msg !== null && <span className={styles.msg}>{msg}</span>}
      </div>
    </div>
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

  if (error !== null) return <div className={styles.error}>{error}</div>;
  if (secrets === null) return <div className={styles.loading}>loading secrets…</div>;

  const names = Object.keys(secrets);

  return (
    <div className={styles.secrets}>
      {names.length === 0 && <div className={styles.loading}>no secrets stored yet</div>}
      {names.map((name) => (
        <div className={styles.secretRow} key={name}>
          <span className={styles.secretName}>{name}</span>
          <span className={styles.masked}>{secrets[name]}</span>
          <input
            className={styles.input}
            type="password"
            placeholder="new value"
            value={values[name] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
          />
          <button
            className={styles.btn}
            disabled={busy === name || (values[name] ?? "").length === 0}
            onClick={() => void store(name)}
          >
            {busy === name ? "…" : "update"}
          </button>
        </div>
      ))}
      <div className={styles.secretRow}>
        <input
          className={styles.input}
          type="text"
          placeholder="new secret name (e.g. ANTHROPIC_API_KEY)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <input
          className={styles.input}
          type="password"
          placeholder="value"
          value={values[newName] ?? ""}
          onChange={(e) => setValues((v) => ({ ...v, [newName]: e.target.value }))}
        />
        <button className={styles.btn} disabled={newName.trim().length === 0} onClick={() => void addNew()}>
          add
        </button>
      </div>
    </div>
  );
}
