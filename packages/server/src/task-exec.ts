// Per-task execution preferences — a tiny project-local sidecar the submit path
// writes and the deployment's executor factory reads at drive time.
//
// The submit (an HTTP call) and the drive (the CLI's injected `buildExecutor`)
// are DECOUPLED: the watcher polls the store and drives whatever task it finds,
// independent of who submitted it. So a per-task choice that must reach the
// drive cannot ride in memory — it lives in a file the watcher's executor
// factory consults. Today it carries the per-task Docker flag (P4).
//
// Domain-blind: the server stores a boolean it does not interpret; the CLI maps
// it to a container plan. Written on every submit (so a new task's choice
// replaces the last); absent / unreadable → the deployment default.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface TaskExecPrefs {
  // true → run this task's spawns in the container; false → force the worktree;
  // absent → the deployment default (the server-wide --docker/--no-docker plan).
  docker?: boolean;
  // Submit-time "ship on accept" choices: on a terminal accept the watcher
  // pushes the task's branch / squash-merges it into the operator's checkout
  // (the "fix it, push after it finishes, not at my desk" case). Absent → the
  // operator ships manually via the post-completion buttons. Domain-blind
  // booleans the server stores and the watcher's merge-back wrapper acts on.
  push?: boolean;
  squash_merge?: boolean;
}

export function taskExecPath(projectDir: string): string {
  return join(projectDir, ".claude", "loom", "task-exec.json");
}

export function writeTaskExecPrefs(projectDir: string, prefs: TaskExecPrefs): void {
  const path = taskExecPath(projectDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(prefs), "utf8");
}

export function readTaskExecPrefs(projectDir: string): TaskExecPrefs {
  try {
    const parsed = JSON.parse(readFileSync(taskExecPath(projectDir), "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const out: TaskExecPrefs = {};
      if (typeof obj["docker"] === "boolean") out.docker = obj["docker"];
      if (typeof obj["push"] === "boolean") out.push = obj["push"];
      if (typeof obj["squash_merge"] === "boolean") out.squash_merge = obj["squash_merge"];
      return out;
    }
  } catch {
    /* no sidecar / unreadable → the deployment default */
  }
  return {};
}
