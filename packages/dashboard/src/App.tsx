import { useState } from "react";

import styles from "./App.module.css";
import { Onboarding } from "./components/Onboarding.js";
import { useApi } from "./hooks/useApi.js";
import { getToken, setToken } from "./lib/api.js";
import { cx } from "./lib/cx.js";
import { AddProjectView } from "./views/AddProjectView.js";
import { ProjectDetail } from "./views/ProjectDetail.js";
import { ProjectsView } from "./views/ProjectsView.js";
import { ProvidersView } from "./views/ProvidersView.js";
import { SettingsView } from "./views/SettingsView.js";

type View = "projects" | "settings" | "providers" | "add";

interface OpenProject {
  id: string;
  dir: string;
  label?: string;
}

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

export function App() {
  const [view, setView] = useState<View>("projects");
  const [open, setOpen] = useState<OpenProject | null>(null);
  const [token, setTokenInput] = useState(getToken());
  // Bump to nudge views that fetch on mount to re-detect after an onboarding /
  // add-project action (without a global data layer).
  const [refreshKey, setRefreshKey] = useState(0);

  const save = (): void => {
    setToken(token.trim());
    setRefreshKey((k) => k + 1);
  };

  const goProjects = (): void => {
    setOpen(null);
    setView("projects");
  };

  const refresh = (): void => setRefreshKey((k) => k + 1);

  return (
    <div className={styles.app}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>loom</div>
        <nav className={styles.nav}>
          {NAV.map((n) => (
            <button
              key={n.id}
              className={cx(styles.navItem, view === n.id && open === null && styles.navItemActive)}
              onClick={() => {
                setOpen(null);
                setView(n.id);
              }}
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
        {open === null && <Onboarding key={refreshKey} onChanged={refresh} />}

        {open !== null ? (
          <ProjectDetail
            projectId={open.id}
            dir={open.dir}
            {...(open.label !== undefined ? { label: open.label } : {})}
            onBack={goProjects}
          />
        ) : (
          <>
            {view === "projects" && <ProjectsView key={refreshKey} onOpen={setOpen} />}
            {view === "settings" && <SettingsView />}
            {view === "providers" && <ProvidersView />}
            {view === "add" && (
              <AddProjectView
                onAdded={() => {
                  refresh();
                  goProjects();
                }}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}
