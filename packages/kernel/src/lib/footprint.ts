// The project's (and user's) on-disk footprint — one resolution point.
//
// loom keeps its per-project working set under `<project>/.loom/` and its
// user-global operator files under `~/.loom/`. The directory name names the
// TOOL, not a backend: a project driven entirely on non-Claude models has no
// `.claude/` of loom's at all. (Claude Code's OWN `<project>/.claude/`
// settings + `~/.claude.json` / `~/.claude/commands/` / `.credentials.json`
// are a separate, vendor-owned subtree this module never touches.)
//
// Earlier versions wrote that footprint under `.claude/`. `projectFootprintDir`
// / `userFootprintDir` are the single resolution points every consumer goes
// through, and each performs a one-shot, idempotent, per-process-cached
// migration of the loom-owned entries out of the legacy `.claude/` location
// the first time it is asked for a given dir. Embedding the move at the
// resolution point — rather than at one scattered entry — guarantees the
// store / daemon trail / history / config are relocated before ANY consumer
// (kernel pool, daemon logger, server, CLI) reads them, regardless of which
// touches the project first. The move is a same-filesystem `rename` (the two
// dirs are siblings), so it is atomic per entry; the cache keeps repeat
// resolutions to a single Set lookup.

import {
  existsSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// The provider-neutral footprint dir name (per-project AND user-global).
export const FOOTPRINT_DIRNAME = ".loom";
// The vendor-named legacy location loom used to write into. Shared with
// Claude Code's own files, so the migration moves only loom-owned entries.
const LEGACY_DIRNAME = ".claude";

// Loom-owned entries under a PROJECT footprint. Each maps a legacy relative
// path (under `.claude/`) to its destination (under `.loom/`). Anything not
// listed — Claude Code's `settings.json`, `commands/`, etc. — is left in
// `.claude/`. The 0.3.4 host sidecars (`loom/transcripts`, `loom/task-exec.json`)
// flatten up one level: the inner `loom/` namespace only existed to carve loom
// out of the shared `.claude/`, and is redundant now the whole dir is loom's.
const PROJECT_ENTRIES: ReadonlyArray<{ from: string; to: string }> = [
  { from: "state.db", to: "state.db" },
  { from: "state.db-wal", to: "state.db-wal" },
  { from: "state.db-shm", to: "state.db-shm" },
  { from: "state.db-journal", to: "state.db-journal" },
  { from: "daemon", to: "daemon" },
  { from: "history", to: "history" },
  { from: "loom.json", to: "loom.json" },
  { from: "providers.json", to: "providers.json" },
  { from: join("loom", "transcripts"), to: "transcripts" },
  { from: join("loom", "task-exec.json"), to: "task-exec.json" },
];

// Loom-owned entries under the USER-GLOBAL footprint. `~/.claude.json`,
// `~/.claude/commands/`, and `~/.claude/.credentials.json` are Claude Code's
// and stay put; only the operator files loom itself writes move.
const USER_ENTRIES: ReadonlyArray<{ from: string; to: string }> = [
  { from: "projects.allow", to: "projects.allow" },
  { from: "bypass-hmac.key", to: "bypass-hmac.key" },
  { from: "loom-server", to: "server" },
];

const migratedProjects = new Set<string>();
const migratedUsers = new Set<string>();

// Move every present loom-owned entry from `legacyDir` to `targetDir`. Creates
// `targetDir` only when there is at least one entry to move. Same-filesystem
// rename per entry (atomic); a parent dir for a flattened destination is
// created as needed.
function moveEntries(
  legacyDir: string,
  targetDir: string,
  entries: ReadonlyArray<{ from: string; to: string }>,
): void {
  const present = entries.filter((e) => existsSync(join(legacyDir, e.from)));
  if (present.length === 0) return;
  mkdirSync(targetDir, { recursive: true });
  for (const e of present) {
    const dest = join(targetDir, e.to);
    if (existsSync(dest)) continue; // never clobber an already-present target
    const destParent = join(dest, "..");
    mkdirSync(destParent, { recursive: true });
    try {
      renameSync(join(legacyDir, e.from), dest);
    } catch {
      // A cross-device or permission failure on one entry must not abort the
      // others or the caller; the legacy copy is left intact for a retry.
    }
  }
}

// Resolve a project's footprint dir, migrating the loom-owned subtree out of
// any legacy `.claude/` on first resolution. Idempotent + per-process cached.
// Prefers an existing `.loom/` (if both exist, the new location wins and no
// move runs).
export function projectFootprintDir(projectDir: string): string {
  const resolvedDir = resolve(projectDir);
  const target = join(resolvedDir, FOOTPRINT_DIRNAME);
  if (!migratedProjects.has(resolvedDir)) {
    migratedProjects.add(resolvedDir);
    if (!existsSync(target)) {
      moveEntries(join(resolvedDir, LEGACY_DIRNAME), target, PROJECT_ENTRIES);
    }
  }
  return target;
}

// Resolve the user-global footprint dir, migrating loom's operator files out of
// any legacy `~/.claude/` on first resolution. Same one-shot/idempotent/cached
// contract as the project variant.
export function userFootprintDir(homeDir?: string): string {
  const home = homeDir ?? process.env.HOME ?? homedir();
  const target = join(home, FOOTPRINT_DIRNAME);
  if (!migratedUsers.has(home)) {
    migratedUsers.add(home);
    if (!existsSync(target)) {
      moveEntries(join(home, LEGACY_DIRNAME), target, USER_ENTRIES);
    }
  }
  return target;
}

// Test-only: clear the per-process migration caches so a test can drive the
// one-shot move more than once against fresh temp dirs.
export function _resetFootprintCacheForTest(): void {
  migratedProjects.clear();
  migratedUsers.clear();
}
