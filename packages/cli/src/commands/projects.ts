// `loom projects add [path] [--label <l>]` / `loom projects list` /
// `loom projects remove <id|path>` — the project CATALOG: the known projects a
// user has worked on, browsable with their current status even when no server
// runs.
//
// The catalog (in `~/.config/loom/workspace.json`) is distinct from the server's
// live supervised set: `add`/`remove` only edit the catalog, and `list` reads
// each project's status from its own store via the server's domain-blind
// `readProjectStatus` — no supervision required. The stable project id matches
// the server's `projectId`, so a catalog entry lines up with a supervised one.
//
// The id + status helpers pull the kernel/store, so this is a SQLite-class
// command (dynamic imports; the flag is set by the re-exec). Tests inject both.

import { resolve } from "node:path";

import {
  addProject,
  listProjects,
  removeProject,
  resolveLoomHome,
  type WorkspaceEntry,
} from "@loomfsm/config";

import type { CliEnv } from "../lib/env.js";
import type { ProjectStatusView } from "@loomfsm/server";

export interface ProjectsOverrides {
  loomHome?: string;
  projectId?: (dir: string) => string;
  readStatus?: (dir: string, nowMs: number) => Promise<ProjectStatusView>;
  // Wall-clock seams for tests.
  now?: number;
  nowIso?: string;
}

export async function projects(
  argv: string[],
  env: CliEnv,
  overrides: ProjectsOverrides = {},
): Promise<number> {
  const home = overrides.loomHome ?? resolveLoomHome(process.env, env.home);
  const [sub, ...rest] = argv;
  switch (sub) {
    case "add":
      return await addCmd(rest, env, home, overrides);
    case "list":
      return await listCmd(env, home, overrides);
    case "remove":
      return await removeCmd(rest, env, home, overrides);
    default:
      env.err(`loom projects: expected 'add', 'list', or 'remove', got ${sub ?? "(nothing)"}`);
      return 1;
  }
}

async function resolveProjectId(
  overrides: ProjectsOverrides,
): Promise<(dir: string) => string> {
  if (overrides.projectId !== undefined) return overrides.projectId;
  return (await import("@loomfsm/server")).projectId;
}

async function addCmd(
  rest: string[],
  env: CliEnv,
  home: string,
  overrides: ProjectsOverrides,
): Promise<number> {
  const { path, label } = parseAddArgs(rest, env.cwd);
  const dir = resolve(path);
  const id = (await resolveProjectId(overrides))(dir);
  const addedAt = overrides.nowIso ?? new Date().toISOString();

  const entry: WorkspaceEntry = {
    id,
    dir,
    added_at: addedAt,
    ...(label !== undefined ? { label } : {}),
  };
  addProject(home, entry);
  env.out(`loom projects: added ${id}  ${dir}${label !== undefined ? `  (${label})` : ""}`);
  return 0;
}

async function listCmd(env: CliEnv, home: string, overrides: ProjectsOverrides): Promise<number> {
  const entries = listProjects(home);
  if (entries.length === 0) {
    env.out("loom projects: catalog is empty — add one with 'loom projects add'");
    return 0;
  }
  const readStatus =
    overrides.readStatus ?? (await import("@loomfsm/server")).readProjectStatus;
  const nowMs = overrides.now ?? Date.now();

  for (const e of entries) {
    const label = e.label !== undefined ? `  (${e.label})` : "";
    env.out(`${e.id}  ${e.dir}${label}`);
    let status: ProjectStatusView;
    try {
      status = await readStatus(e.dir, nowMs);
    } catch (err) {
      env.out(`    status: unavailable (${(err as Error).message})`);
      continue;
    }
    env.out(`    ${describeStatus(status)}`);
  }
  return 0;
}

async function removeCmd(
  rest: string[],
  env: CliEnv,
  home: string,
  overrides: ProjectsOverrides,
): Promise<number> {
  const target = rest[0];
  if (target === undefined) {
    env.err("loom projects remove: usage — loom projects remove <id|path>");
    return 1;
  }
  // A known id removes directly; otherwise treat the arg as a path and resolve
  // it to the same stable id `add` used.
  const known = listProjects(home).some((p) => p.id === target);
  const id = known ? target : (await resolveProjectId(overrides))(resolve(target));
  const { removed } = removeProject(home, id);
  if (removed) {
    env.out(`loom projects: removed ${id}`);
    return 0;
  }
  env.out(`loom projects: no catalog entry for '${target}'`);
  return 0;
}

// ----- internals ----------------------------------------------------------

function parseAddArgs(rest: string[], cwd: string): { path: string; label?: string } {
  let path = cwd;
  let label: string | undefined;
  let sawPath = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === undefined) continue;
    if (a === "--label") {
      const v = rest[++i];
      if (v !== undefined) label = v;
    } else if (!a.startsWith("-") && !sawPath) {
      path = a;
      sawPath = true;
    }
  }
  return label !== undefined ? { path, label } : { path };
}

function describeStatus(s: ProjectStatusView): string {
  if (!s.has_task) return "status: no active task";
  const parts: string[] = [];
  parts.push(`task: ${s.task_label ?? s.task_id ?? "?"}`);
  if (s.status !== null) parts.push(s.verdict !== null ? `${s.status}/${s.verdict}` : s.status);
  if (s.flow !== null) parts.push(`flow ${s.flow.name}#${s.flow.step_index}`);
  if (s.parked_gate !== null) parts.push(`parked@${s.parked_gate.gate}`);
  if (s.stalled) parts.push("STALLED");
  return parts.join("  ");
}
