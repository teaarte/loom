import { useState } from "react";

import { api, ApiError, errText } from "../lib/api.js";

export interface TaskControlsState {
  // The verb of the action currently in flight (for per-button spinners), or null.
  busy: string | null;
  msg: string | null;
  // Pause = unregister (stop driving, keep the task). Resume = re-register the
  // project dir → recover-on-start re-drives the in-flight task. Cancel =
  // abort + force-archive (free the slot). Ship = push / squash-merge the task
  // branch. Each is a PEER of the CLI/registry path; domain-blind.
  pause: () => Promise<void>;
  resume: (dir: string) => Promise<void>;
  cancel: () => Promise<void>;
  ship: (verb: "push" | "merge") => Promise<void>;
}

// The task lifecycle controls over the SAME registry machinery the CLI uses.
// Owns the in-flight verb + message; the view decides which buttons to show from
// the read-model status + whether a watcher is attached.
export function useTaskControls(projectId: string): TaskControlsState {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const id = encodeURIComponent(projectId);

  const act = async (verb: string, run: () => Promise<unknown>): Promise<void> => {
    setBusy(verb);
    setMsg(null);
    try {
      await run();
      setMsg(`${verb} ✓`);
    } catch (err) {
      setMsg(errText(err));
    } finally {
      setBusy(null);
    }
  };

  return {
    busy,
    msg,
    pause: () => act("paused", () => api("DELETE", `/projects/${id}`)),
    resume: (dir: string) => act("resumed", () => api("POST", "/projects", { dir })),
    cancel: () => act("cancelled", () => api("POST", `/projects/${id}/cancel`)),
    // The server returns `{ pushed:false, reason }` on a clean refusal (no remote
    // / dirty / non-git), so surface the reason rather than a bare "✓".
    ship: (verb: "push" | "merge") =>
      act(verb, async () => {
        const r = await api<{ pushed?: boolean; merged?: boolean; reason?: string }>("POST", `/projects/${id}/${verb}`);
        const ok = verb === "push" ? r.pushed : r.merged;
        if (ok !== true) throw new ApiError(400, r.reason ?? "refused", `not ${verb}ed: ${r.reason ?? "refused"}`);
      }),
  };
}
