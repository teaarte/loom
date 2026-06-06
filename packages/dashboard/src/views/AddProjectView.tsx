// Add a project — TWO distinct actions the UI keeps visibly separate, because
// they hit different stores and mean different things:
//
//   • Catalog (`POST /workspace/projects`): "a project I've worked on." It is
//     remembered so its status reads even when idle, but it is NOT supervised —
//     no watcher attaches. This is the durable known-projects list the CLI's
//     `loom projects add` writes.
//   • Supervise (`POST /projects`): attach a LIVE watcher now, so a submitted
//     task is driven. This is the server's in-process registry (`loom serve`'s
//     live set), not the durable catalog.
//
// A project is commonly added to BOTH; the form makes the choice explicit rather
// than guessing.

import { useState } from "react";

import { api, errText } from "../lib/api.js";
import styles from "./AddProjectView.module.css";

export function AddProjectView({ onAdded }: { onAdded: () => void }) {
  const [dir, setDir] = useState("");
  const [label, setLabel] = useState("");
  const [bundle, setBundle] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<"catalog" | "supervise" | null>(null);

  const addToCatalog = async (): Promise<void> => {
    const d = dir.trim();
    if (d.length === 0) {
      setMsg("enter a project directory");
      return;
    }
    setBusy("catalog");
    setMsg(null);
    try {
      const r = await api<{ id: string }>("POST", "/workspace/projects", {
        dir: d,
        ...(label.trim().length > 0 ? { label: label.trim() } : {}),
        ...(bundle.trim().length > 0 ? { bundle: bundle.trim() } : {}),
      });
      setMsg(`added to catalog as ${r.id}`);
      onAdded();
    } catch (err) {
      setMsg(errText(err));
    } finally {
      setBusy(null);
    }
  };

  const supervise = async (): Promise<void> => {
    const d = dir.trim();
    if (d.length === 0) {
      setMsg("enter a project directory");
      return;
    }
    setBusy("supervise");
    setMsg(null);
    try {
      const r = await api<{ id: string }>("POST", "/projects", { dir: d });
      setMsg(`now supervising ${r.id}`);
      onAdded();
    } catch (err) {
      setMsg(errText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <h1>Add a project</h1>

      <label className={styles.field}>
        <span className={styles.label}>project directory (absolute path)</span>
        <input
          className={styles.input}
          type="text"
          placeholder="/abs/path/to/project"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
        />
      </label>

      <div className={styles.cards}>
        <div className={styles.card}>
          <h2>Add to catalog</h2>
          <p className={styles.desc}>
            Remember this project so its status shows here even when idle. It is not supervised — no
            watcher attaches until you supervise it or submit a task.
          </p>
          <label className={styles.field}>
            <span className={styles.label}>label (optional)</span>
            <input
              className={styles.input}
              type="text"
              placeholder="my-service"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>bundle (optional)</span>
            <input
              className={styles.input}
              type="text"
              placeholder="(default)"
              value={bundle}
              onChange={(e) => setBundle(e.target.value)}
            />
          </label>
          <button className={styles.btn} disabled={busy !== null} onClick={() => void addToCatalog()}>
            {busy === "catalog" ? "adding…" : "add to catalog"}
          </button>
        </div>

        <div className={styles.card}>
          <h2>Supervise now</h2>
          <p className={styles.desc}>
            Attach a live watcher in this control plane so a submitted task is driven. This is the
            active supervised set — distinct from the durable catalog.
          </p>
          <button className={styles.btn} disabled={busy !== null} onClick={() => void supervise()}>
            {busy === "supervise" ? "attaching…" : "supervise now"}
          </button>
        </div>
      </div>

      {msg !== null && <div className={styles.msg}>{msg}</div>}
    </div>
  );
}
