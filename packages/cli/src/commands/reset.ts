// `loom reset [path] [--force] [--dry-run]` — archive this project's
// finished task into .loom/history/ and free the single-task slot, so the
// next task starts clean. The everyday unblock for a project whose previous
// task finished (or jammed in a terminal-but-uncleared state) and is now
// refusing a new task. A genuinely in-progress task is refused without
// --force so a live run is never discarded.
//
// `loom history [path]` — list the archived tasks from the history index.
//
// Operator-direct: unlike the MCP tool these do not consult the project
// allowlist — the person at the terminal IS the operator acting on their own
// directory. The kernel is imported lazily so the SQLite-free install
// commands (setup / allowlist / init) keep a flag-free launcher; the bin
// re-execs with the experimental-sqlite flag only for `reset`.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { firstUnknownFlag, parseArgs } from "../lib/args.js";
import type { CliEnv } from "../lib/env.js";

const RESET_KNOWN_FLAGS = ["force", "dry-run"] as const;

export async function reset(argv: string[], env: CliEnv): Promise<number> {
  const { positionals, flags } = parseArgs(argv);
  const unknown = firstUnknownFlag(flags, RESET_KNOWN_FLAGS);
  if (unknown !== null) {
    env.err(`loom reset: unknown flag --${unknown}`);
    return 1;
  }
  const force = flags.has("force");
  const dryRun = flags.has("dry-run");
  const target =
    positionals.length > 0 && positionals[0] !== undefined
      ? resolve(env.cwd, positionals[0])
      : env.cwd;

  // Resolving the footprint dir also migrates any legacy `.claude/` store into
  // `.loom/` (one-shot), so the existsSync check below sees the real location.
  const { archiveAndReset, captureNow, peekArchiveSlot, projectFootprintDir, KernelError } =
    await import("@loomfsm/kernel");

  if (!existsSync(join(projectFootprintDir(target), "state.db"))) {
    env.out(`no active task in ${target} — nothing to reset`);
    return 0;
  }

  if (dryRun) {
    const slot = await peekArchiveSlot(target);
    if (slot === null) {
      env.out(`no active task in ${target} — nothing to reset`);
      return 0;
    }
    if (slot.status === "in_progress" && !force) {
      env.out(`[dry-run] ${target}: a task is in progress (${slot.task_id ?? "unknown"})`);
      env.out(`[dry-run] would refuse without --force`);
      return 0;
    }
    env.out(
      `[dry-run] would archive ${slot.task_id ?? "(unknown)"} (status ${slot.status ?? "?"}) ` +
        `into .loom/history/ and free the slot`,
    );
    return 0;
  }

  try {
    const result = await archiveAndReset(
      target,
      captureNow(),
      force ? { force: true } : undefined,
    );
    if (!result.archived) {
      env.out(`no active task in ${target} — nothing to reset`);
      return 0;
    }
    env.out(`archived ${result.task_id ?? "(unknown)"} → ${result.history_path}`);
    env.out(`slot cleared — the next task in ${target} starts fresh`);
    return 0;
  } catch (err) {
    if (err instanceof KernelError && err.code === "PROJECT_TASK_ACTIVE") {
      env.err(`loom reset: ${err.message}`);
      env.err("  re-run with --force to archive the in-progress task anyway");
      return 1;
    }
    env.err(`loom reset: ${(err as Error).message}`);
    return 1;
  }
}

interface HistoryLine {
  task_id?: unknown;
  task_short?: unknown;
  task?: unknown;
  verdict?: unknown;
  status?: unknown;
  archived_at?: unknown;
}

export function history(argv: string[], env: CliEnv): number {
  const { positionals } = parseArgs(argv);
  const target =
    positionals.length > 0 && positionals[0] !== undefined
      ? resolve(env.cwd, positionals[0])
      : env.cwd;
  // `loom history` runs without the SQLite flag, so it cannot import the kernel
  // to trigger the footprint migration; it reads the new `.loom/` location and
  // falls back to a legacy `.claude/` index a sqlite command has not migrated
  // yet (the next `reset`/`run`/`status` relocates it).
  const loomIndex = join(target, ".loom", "history", "index.jsonl");
  const indexPath = existsSync(loomIndex)
    ? loomIndex
    : join(target, ".claude", "history", "index.jsonl");
  if (!existsSync(indexPath)) {
    env.out(`no archived tasks in ${target}`);
    return 0;
  }
  const lines = readFileSync(indexPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) {
    env.out(`no archived tasks in ${target}`);
    return 0;
  }
  for (const line of lines) {
    let entry: HistoryLine;
    try {
      entry = JSON.parse(line) as HistoryLine;
    } catch {
      env.out(line); // tolerate a malformed line rather than crash the listing
      continue;
    }
    const id = entry.task_id === undefined || entry.task_id === null ? "(unknown)" : String(entry.task_id);
    const status = entry.status === undefined || entry.status === null ? "?" : String(entry.status);
    const verdict =
      entry.verdict === undefined || entry.verdict === null ? "" : `/${String(entry.verdict)}`;
    const when = entry.archived_at === undefined || entry.archived_at === null ? "" : String(entry.archived_at);
    const label = describeTask(entry);
    env.out(`${when}  ${id}  [${status}${verdict}]  ${label}`);
  }
  return 0;
}

function describeTask(entry: HistoryLine): string {
  if (entry.task_short !== undefined && entry.task_short !== null && String(entry.task_short).length > 0) {
    return String(entry.task_short);
  }
  if (entry.task === undefined || entry.task === null) return "";
  const text = String(entry.task);
  return text.length > 72 ? `${text.slice(0, 69)}...` : text;
}
