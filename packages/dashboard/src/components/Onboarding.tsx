// A detect-once, dismissible onboarding panel. On first load it probes
// `GET /providers` (is any backend available?) and `GET /workspace` (any project
// yet?); if a backend is usable AND a project exists, it renders nothing. It
// NEVER blocks the rest of the UI and the headless path never reaches it (there
// is no UI there). A purely-visual "shown once" flag lives in localStorage — it
// is the only client-only state, and it is a preference, not control state.
//
// The panel guides three steps over the SAME routes the views use: pick a
// backend (`PUT /config`), optionally store a credential secret
// (`PUT /secrets/:name`), and add a first project (`POST /workspace/projects`).
// Backend names are infra DATA from `/providers` — nothing here is hardcoded.

import { useCallback, useEffect, useState } from "react";

import { api } from "../lib/api.js";
import type { LoomConfigShape, ProvidersResponse, WorkspaceResponse } from "../lib/types.js";
import styles from "./Onboarding.module.css";

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

export function Onboarding({ onChanged }: { onChanged: () => void }) {
  const [hidden, setHidden] = useState(dismissed());
  const [needed, setNeeded] = useState<boolean | null>(null);
  const [providers, setProviders] = useState<ProvidersResponse | null>(null);

  const [backend, setBackend] = useState("");
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [dir, setDir] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

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

  const saveBackend = async (): Promise<void> => {
    if (backend.length === 0) return;
    try {
      const cfg = await api<LoomConfigShape>("GET", "/config");
      await api("PUT", "/config", { ...cfg, backend });
      setMsg(`backend set to ${backend}`);
      onChanged();
      void detect();
    } catch (err) {
      setMsg(String(err));
    }
  };

  const saveSecret = async (): Promise<void> => {
    if (secretName.trim().length === 0 || secretValue.length === 0) return;
    try {
      await api("PUT", `/secrets/${encodeURIComponent(secretName.trim())}`, { value: secretValue });
      setSecretValue("");
      setMsg(`stored secret ${secretName.trim()}`);
      void detect();
    } catch (err) {
      setMsg(String(err));
    }
  };

  const addProject = async (): Promise<void> => {
    if (dir.trim().length === 0) return;
    try {
      await api("POST", "/workspace/projects", { dir: dir.trim() });
      setMsg(`added ${dir.trim()}`);
      onChanged();
      void detect();
    } catch (err) {
      setMsg(String(err));
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <strong>Welcome to loom</strong>
        <button className={styles.dismiss} onClick={dismiss}>
          dismiss
        </button>
      </div>
      <p className={styles.intro}>
        A couple of one-time steps to get a task running. You can skip any of these and configure
        them later in Settings.
      </p>

      <div className={styles.step}>
        <span className={styles.stepLabel}>1 · choose a backend</span>
        <select className={styles.input} value={backend} onChange={(e) => setBackend(e.target.value)}>
          <option value="">(pick a backend)</option>
          {providers?.providers.map((p) => (
            <option key={p.backend} value={p.backend}>
              {p.backend}
              {p.available === true ? " — available" : p.available === false ? " — needs setup" : ""}
            </option>
          ))}
        </select>
        <button className={styles.btn} disabled={backend.length === 0} onClick={() => void saveBackend()}>
          set
        </button>
      </div>

      <div className={styles.step}>
        <span className={styles.stepLabel}>2 · credential (if the backend needs an API key)</span>
        <input
          className={styles.input}
          type="text"
          placeholder="secret name"
          value={secretName}
          onChange={(e) => setSecretName(e.target.value)}
        />
        <input
          className={styles.input}
          type="password"
          placeholder="value (write-only)"
          value={secretValue}
          onChange={(e) => setSecretValue(e.target.value)}
        />
        <button
          className={styles.btn}
          disabled={secretName.trim().length === 0 || secretValue.length === 0}
          onClick={() => void saveSecret()}
        >
          store
        </button>
      </div>

      <div className={styles.step}>
        <span className={styles.stepLabel}>3 · add your first project</span>
        <input
          className={styles.input}
          type="text"
          placeholder="/abs/path/to/project"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
        />
        <button className={styles.btn} disabled={dir.trim().length === 0} onClick={() => void addProject()}>
          add
        </button>
      </div>

      {msg !== null && <div className={styles.msg}>{msg}</div>}
    </div>
  );
}
