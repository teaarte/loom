// Providers: each backend, the provider families it can run, and a best-effort
// availability signal the server knows WITHOUT spawning (an API-key backend
// reports whether its credential resolves; Claude Code an injected presence
// probe; a local / external-CLI backend is reported as not probed). The
// configured backend mode is highlighted. These are cross-bundle INFRA names,
// not a bundle's domain.

import { useApi } from "../hooks/useApi.js";
import { cx } from "../lib/cx.js";
import type { ProvidersResponse } from "../lib/types.js";
import styles from "./ProvidersView.module.css";

function availabilityLabel(available: boolean | null): { tone: string; text: string } {
  if (available === true) return { tone: styles.ok ?? "", text: "available" };
  if (available === false) return { tone: styles.bad ?? "", text: "unavailable" };
  return { tone: styles.unknown ?? "", text: "not probed" };
}

export function ProvidersView() {
  const { data, error } = useApi<ProvidersResponse>("/providers", 10000);

  return (
    <div>
      <h1>Providers</h1>
      {error && <div className={styles.error}>{error.message}</div>}
      {data && (
        <>
          <div className={styles.mode}>
            backend mode: <strong>{data.backend_mode}</strong>
            {data.backend_mode === "auto" && (
              <span className={styles.modeNote}> — auto picks a compatible backend per spawn</span>
            )}
          </div>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>backend</th>
                <th>families</th>
                <th>availability</th>
              </tr>
            </thead>
            <tbody>
              {data.providers.map((p) => {
                const av = availabilityLabel(p.available);
                const active = p.backend === data.backend_mode;
                return (
                  <tr key={p.backend} className={cx(active && styles.active)}>
                    <td className={styles.backend}>
                      {p.backend}
                      {active && <span className={styles.activeTag}> · selected</span>}
                    </td>
                    <td>{p.families.join(", ")}</td>
                    <td>
                      <span className={cx(styles.avail, av.tone)}>{av.text}</span>
                      {p.reason && <span className={styles.reason}> — {p.reason}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
