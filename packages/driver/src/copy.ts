// Copy-on-write full-tree copy — the isolation primitive shared by both
// sandboxed backends.
//
// The sandbox must carry the WHOLE project, not just git-tracked files: a real
// project keeps gitignored generated code (a Prisma client, protobuf/graphql
// output) and `node_modules` that an agent needs to READ to do its job. A git
// checkout (worktree / `git clone --local`) contains ONLY tracked files, so a
// headless agent hit "path does not exist" on the generated code — the very
// subject of its task — and flailed. The fix is generic by construction: copy
// the whole directory (gitignored files, `node_modules`, generated code, AND
// `.git` so the self-diff / merge-back still work), made ONCE per task and
// reused across that task's spawns. No per-tool setup (`prisma generate` /
// `npm ci`) — those are crutches (today Prisma, tomorrow protobuf).
//
// It is cheap because it prefers COPY-ON-WRITE: macOS APFS clonefile (`cp -c`)
// and Linux reflink (`cp --reflink`) make the copy instant and ~zero extra disk
// until a file diverges. Where CoW is unavailable it falls back to a full byte
// copy (complete but heavy on a big `node_modules` — the caller surfaces a
// notice). CoW is a generic "copy the folder" fast path, NOT a per-platform
// crutch.
//
// Ambient I/O (spawnSync, fs) is fine — this is transport runtime OUTSIDE the
// kernel's replay graph.

import { spawnSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface CopyResult {
  ok: boolean;
  // True when a copy-on-write fast path was used (instant, ~zero disk); false
  // when it fell back to a full byte copy (complete but heavy).
  cow: boolean;
  stderr: string;
}

function runCp(args: string[]): { ok: boolean; stderr: string } {
  const res = spawnSync("cp", args, { encoding: "utf8" });
  if (res.error !== undefined) return { ok: false, stderr: String(res.error) };
  return { ok: res.status === 0, stderr: typeof res.stderr === "string" ? res.stderr : "" };
}

function removePartial(dst: string): void {
  try {
    rmSync(dst, { recursive: true, force: true });
  } catch {
    /* best effort — a lingering partial is cleaned by the next attempt's check */
  }
}

// Copy the ENTIRE source tree (gitignored files, `node_modules`, generated
// code, and `.git`) to a fresh `dst` (which MUST NOT pre-exist — the caller
// reuses an existing copy across re-resume). Prefers copy-on-write:
//
//   macOS  → `cp -Rc` (APFS clonefile); FAILS off-APFS / cross-volume,
//            then a plain `cp -R`.
//   Linux  → `cp -a --reflink=always`; FAILS off btrfs/xfs,
//            then a full `cp -a`.
//   other  → node:fs recursive copy (no CoW).
//
// `forcePlain` skips the CoW attempt so the heavy fallback path is testable on
// a CoW-capable filesystem. Never throws — returns `{ ok:false }` on failure.
export function copyTree(src: string, dst: string, opts: { forcePlain?: boolean } = {}): CopyResult {
  const platform = process.platform;

  if (opts.forcePlain !== true) {
    if (platform === "darwin") {
      const clone = runCp(["-Rc", src, dst]);
      if (clone.ok) return { ok: true, cow: true, stderr: "" };
      removePartial(dst); // clonefile may leave a partial tree before erroring
    } else if (platform === "linux") {
      const reflink = runCp(["-a", "--reflink=always", src, dst]);
      if (reflink.ok) return { ok: true, cow: true, stderr: "" };
      removePartial(dst);
    }
  }

  // Heavy fallback: a full byte copy. `cp` handles symlinks / perms / special
  // files in a real tree better than the node builtin, so prefer it on POSIX.
  if (platform === "darwin" || platform === "linux") {
    const plain = platform === "linux" ? runCp(["-a", src, dst]) : runCp(["-R", src, dst]);
    if (plain.ok) return { ok: true, cow: false, stderr: "" };
    removePartial(dst);
  }

  // Last resort (non-POSIX, or `cp` itself missing): the node builtin.
  try {
    cpSync(src, dst, { recursive: true });
    return { ok: true, cow: false, stderr: "" };
  } catch (e) {
    return { ok: false, cow: false, stderr: e instanceof Error ? e.message : String(e) };
  }
}

// Drop a stale `.git/index.lock` carried over by the copy (the source repo may
// have had one in flight at copy time). Best-effort — a missing lock is the
// normal case and any failure is non-fatal.
export function clearGitLocks(dir: string): void {
  try {
    rmSync(join(dir, ".git", "index.lock"), { force: true });
  } catch {
    /* non-fatal */
  }
}

// The standard "heavy fallback" notice — a full byte copy was made because
// copy-on-write was unavailable. Shared so both backends word it identically.
export function heavyCopyNotice(projectDir: string, dest: string): string {
  return (
    `copy-on-write unavailable for ${projectDir}; made a FULL copy at ${dest} ` +
    `(complete but heavy — includes node_modules). For an instant, near-zero-disk ` +
    `sandbox, place the project on a copy-on-write filesystem (APFS / btrfs / xfs).`
  );
}
