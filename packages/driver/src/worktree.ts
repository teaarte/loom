// Task worktree provisioning for the sandboxed executor.
//
// A headless spawn runs in an ISOLATED git worktree so the agent's edits
// land in a separate working copy, never the project's main tree. The store
// is single-task per project, so there is exactly one worktree per project;
// its path is a deterministic function of the project root, so a re-resume
// (a fresh executor instance for the same task) REUSES the existing worktree
// instead of recreating it — idempotent, the same property the loop relies
// on for `agent_run_id` reuse.
//
// The worktree lives OUTSIDE the repo (under the OS temp dir) so the main
// tree's `git status` stays clean. A project that is not a git work tree
// DEGRADES gracefully: there is no worktree to make, so the spawn runs in the
// project directory directly (no isolation) and the caller is told. This
// mirrors `git-delta`'s degrade-don't-throw posture.
//
// Worktree GC / staleness supervision and merge-back of the worktree's
// changes belong to the long-lived supervisor, not here: this module only
// provisions and reuses.
//
// Ambient I/O (spawnSync, tmpdir) is fine — this is transport runtime OUTSIDE
// the kernel's replay graph.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { gitBaselineRef } from "./git-delta.js";

export interface WorktreeProvision {
  // Where the spawn runs: an isolated worktree, or the project itself when
  // the project is not a git work tree (degraded, no isolation).
  dir: string;
  // The provision-time baseline ref to self-diff the worktree against, or
  // null when there is no git work tree (then no self-diff is computed and
  // the server-side delta stands).
  baseline: string | null;
  // True when `dir` is an isolated worktree distinct from the project root.
  isolated: boolean;
}

// The deterministic worktree path for a project — a stable hash of the
// canonical project root under the OS temp dir, so re-resume finds the same
// worktree. Exported for tests/inspection.
export function worktreePathFor(projectDir: string): string {
  const hash = createHash("sha1").update(resolve(projectDir)).digest("hex").slice(0, 16);
  return join(tmpdir(), `loom-wt-${hash}`);
}

function runGit(cwd: string, args: string[]): { ok: boolean; stderr: string } {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (res.error !== undefined) return { ok: false, stderr: String(res.error) };
  return { ok: res.status === 0, stderr: typeof res.stderr === "string" ? res.stderr : "" };
}

// Provision (or reuse) the active task's worktree. Returns the directory the
// spawn should run in plus the baseline to self-diff against. Never throws:
// any git failure degrades to running in the project directory.
export function provisionWorktree(projectDir: string): WorktreeProvision {
  // HEAD at provision time — the ref the worktree is checked out at and the
  // baseline the self-diff measures against. null/empty-tree for a non-git or
  // commit-less repo: there is then nothing to branch a worktree from.
  const baseline = gitBaselineRef(projectDir);
  if (baseline === null) {
    return { dir: projectDir, baseline: null, isolated: false };
  }

  const wt = worktreePathFor(projectDir);
  if (existsSync(wt)) {
    // Reuse — idempotent across re-resume; do not recreate.
    return { dir: wt, baseline, isolated: true };
  }

  // `--detach` checks out HEAD without claiming a branch name (so repeated
  // tasks never collide on a branch). A commit-less repo (baseline is the
  // empty-tree sha) has no HEAD to check out, so the add fails and we degrade.
  const added = runGit(projectDir, ["worktree", "add", "--detach", wt, "HEAD"]);
  if (added.ok || existsSync(wt)) {
    return { dir: wt, baseline, isolated: true };
  }
  // Could not isolate (e.g. no HEAD, git refused) — run in the project dir.
  return { dir: projectDir, baseline, isolated: false };
}
