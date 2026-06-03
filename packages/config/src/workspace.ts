// The project CATALOG — the persistent list of KNOWN projects, browsable even
// when no server runs. Distinct from the server's `projects.json`, which is the
// live SUPERVISED subset; this leaf only records which projects a user has
// worked on, plus light metadata. Idle status for a card is read elsewhere
// (the server's `readProjectStatus`) and composed by the caller — this file
// holds none of it.
//
// CRUD only, clock-free: the `id` and any timestamps are supplied by the caller
// (the CLI computes the id from the project dir and stamps the time), so this
// leaf needs neither a hashing routine nor a wall-clock.

import { resolve } from "node:path";

import { readWorkspace, writeWorkspace } from "./stores.js";
import type { WorkspaceEntry } from "./types.js";

export function listProjects(loomHome: string): WorkspaceEntry[] {
  return readWorkspace(loomHome);
}

export function getProject(loomHome: string, id: string): WorkspaceEntry | undefined {
  return readWorkspace(loomHome).find((p) => p.id === id);
}

// Upsert by id. A re-add of a known project updates its fields but preserves the
// original `added_at`. The caller supplies the id (stable per dir) and any
// timestamps. Returns the new catalog.
export function addProject(loomHome: string, entry: WorkspaceEntry): WorkspaceEntry[] {
  const projects = readWorkspace(loomHome);
  const normalized: WorkspaceEntry = { ...entry, dir: resolve(entry.dir) };
  const idx = projects.findIndex((p) => p.id === normalized.id);
  if (idx >= 0) {
    const prior = projects[idx];
    projects[idx] = {
      ...normalized,
      ...(prior?.added_at !== undefined && normalized.added_at === undefined
        ? { added_at: prior.added_at }
        : {}),
    };
  } else {
    projects.push(normalized);
  }
  writeWorkspace(loomHome, projects);
  return projects;
}

export interface RemoveResult {
  removed: boolean;
  projects: WorkspaceEntry[];
}

export function removeProject(loomHome: string, id: string): RemoveResult {
  const projects = readWorkspace(loomHome);
  const next = projects.filter((p) => p.id !== id);
  const removed = next.length !== projects.length;
  if (removed) writeWorkspace(loomHome, next);
  return { removed, projects: next };
}

// Patch a catalog entry in place (e.g. stamp `last_opened_at`). No-op when the
// id is unknown. The caller supplies any new timestamp.
export function touchProject(
  loomHome: string,
  id: string,
  patch: Partial<Omit<WorkspaceEntry, "id">>,
): WorkspaceEntry | undefined {
  const projects = readWorkspace(loomHome);
  const idx = projects.findIndex((p) => p.id === id);
  const current = idx >= 0 ? projects[idx] : undefined;
  if (current === undefined) return undefined;
  const updated: WorkspaceEntry = { ...current, ...patch, id };
  projects[idx] = updated;
  writeWorkspace(loomHome, projects);
  return updated;
}
