import { useState } from "react";

import { api, errText } from "../lib/api.js";
import type { SubmitResult } from "../lib/types.js";

// The task payload the submit form builds. `complexity` (when set) folds in as a
// PINNED initial decision the bundle may honour to skip re-classifying; the
// ship-on-accept flags ride the per-task sidecar the watcher reads at finalize.
export interface SubmitInput {
  task: string;
  policy?: string;
  complexity?: string;
  docker?: boolean;
  push?: boolean;
  squashMerge?: boolean;
}

export interface SubmitTaskState {
  busy: boolean;
  msg: string | null;
  submit: (input: SubmitInput) => Promise<void>;
}

// Submit a task to a project — a PEER of `loom run`, posting to the SAME
// `POST /submit` path. Owns the async + busy/message state; the form owns its
// fields. Domain-blind: it forwards a generic `complexity` value + opaque flags;
// it names no agent/flow/gate.
export function useSubmitTask(projectId: string): SubmitTaskState {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const submit = async (input: SubmitInput): Promise<void> => {
    const task = input.task.trim();
    if (task.length === 0) {
      setMsg("enter a task");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<SubmitResult>("POST", "/submit", {
        project: projectId,
        task,
        ...(input.policy !== undefined && input.policy.length > 0 ? { policy_preset: input.policy } : {}),
        ...(input.complexity !== undefined && input.complexity.length > 0
          ? { initial_decisions: { complexity: input.complexity, complexity_pinned: true } }
          : {}),
        ...(input.docker === true ? { docker: true } : {}),
        ...(input.push === true ? { push: true } : {}),
        ...(input.squashMerge === true ? { squash_merge: true } : {}),
      });
      setMsg(`${r.replayed ? "already running" : "submitted"} — ${r.task_id ?? "?"} [${r.status}]`);
    } catch (err) {
      setMsg(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return { busy, msg, submit };
}
