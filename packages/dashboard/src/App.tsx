import { useState } from "react";

import styles from "./App.module.css";
import { useApi } from "./hooks/useApi.js";
import { getToken, setToken } from "./lib/api.js";
import { cx } from "./lib/cx.js";
import { ProjectsView } from "./views/ProjectsView.js";

type View = "projects" | "settings" | "providers" | "add";

const NAV: { id: View; label: string }[] = [
  { id: "projects", label: "Projects" },
  { id: "settings", label: "Settings" },
  { id: "providers", label: "Providers" },
  { id: "add", label: "+ Add" },
];

// A localhost-reachability dot: `/health` needs no token, so a green dot means
// the control plane is up. An API-auth problem (a missing/wrong token) surfaces
// as an error inside the authed views, not here.
function ConnDot() {
  const health = useApi<{ ok: boolean }>("/health", 5000);
  const up = health.data?.ok === true && health.error === null;
  return <span className={cx(styles.dot, up ? styles.dotOk : styles.dotBad)} />;
}

function Placeholder({ name }: { name: string }) {
  return (
    <div>
      <h1>{name}</h1>
      <p style={{ opacity: 0.7 }}>This view lands in a later step of the dashboard build.</p>
    </div>
  );
}

export function App() {
  const [view, setView] = useState<View>("projects");
  const [token, setTokenInput] = useState(getToken());

  const save = (): void => {
    setToken(token.trim());
  };

  return (
    <div className={styles.app}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>loom</div>
        <nav className={styles.nav}>
          {NAV.map((n) => (
            <button
              key={n.id}
              className={cx(styles.navItem, view === n.id && styles.navItemActive)}
              onClick={() => setView(n.id)}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <div className={styles.spacer} />
        <div className={styles.conn}>
          <span className={styles.connLabel}>
            <ConnDot /> token
          </span>
          <input
            className={styles.connInput}
            type="password"
            placeholder="(none — localhost trust)"
            value={token}
            onChange={(e) => setTokenInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
          <button className={styles.connBtn} onClick={save}>
            save
          </button>
        </div>
      </aside>

      <main className={styles.main}>
        {view === "projects" && <ProjectsView />}
        {view === "settings" && <Placeholder name="Settings" />}
        {view === "providers" && <Placeholder name="Providers" />}
        {view === "add" && <Placeholder name="Add a project" />}
      </main>
    </div>
  );
}
