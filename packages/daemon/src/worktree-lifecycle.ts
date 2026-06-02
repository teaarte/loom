// Worktree lifecycle — the half D2 explicitly left to E1: merge-back of the
// isolated worktree's changes, plus GC.
//
// D2 runs each headless spawn in a detached git worktree at a deterministic
// out-of-repo path (`worktreePathFor`) and self-diffs it, but it never
// integrates or cleans the result — "D2 isolates and accounts; it does not
// auto-merge." On `complete` the supervisor here commits the worktree's work
// to a branch `loom/<task_id>` (the branch ref outlives the worktree dir),
// then removes the worktree. It NEVER auto-merges into the operator's checked
// out branch — the work lands reviewable on its own branch, and the operator
// merges (or discards) it deliberately.
//
// Domain-blind: this reasons about git refs and paths only — never a
// bundle's vocabulary (the driver/daemon-leak gate stays green).

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

import { worktreePathFor } from "@loomfsm/driver";

export interface MergeBackResult {
  // True when the worktree's work was committed to a `loom/<task>` branch.
  merged: boolean;
  // Present when merged: the branch name, its tip sha, and the file set
  // (name-only) relative to the project's current HEAD — surfaced so the
  // operator can review before merging.
  branch?: string;
  head_sha?: string;
  files_changed?: string[];
  // The worktree dir was removed (GC ran).
  worktree_removed?: boolean;
  // When not merged, why: "no-worktree" (degraded/non-git/never-provisioned),
  // "no-git", "no-head", or "no-changes".
  reason?: string;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[]): GitResult {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return {
    ok: res.error === undefined && res.status === 0,
    stdout: typeof res.stdout === "string" ? res.stdout.trim() : "",
    stderr: typeof res.stderr === "string" ? res.stderr : "",
  };
}

function isWorkTree(dir: string): boolean {
  const r = git(dir, ["rev-parse", "--is-inside-work-tree"]);
  return r.ok && r.stdout === "true";
}

// A task id is server-issued and well-formed, but keep the branch ref strict
// regardless: anything outside a conservative ref-safe set becomes a dash.
function branchNameFor(taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+/, "");
  return `loom/${safe.length > 0 ? safe : "task"}`;
}

// Commit the task's worktree to a `loom/<task_id>` branch and (by default)
// GC the worktree. Idempotent: a re-run force-updates the branch and a
// missing worktree is a clean no-op. Never throws on a git failure — it
// degrades to `{ merged: false, reason }` so a merge-back hiccup never
// crashes the supervisor mid-completion.
export function commitToBranchMergeBack(
  projectDir: string,
  taskId: string | null,
  opts: { gc?: boolean } = {},
): MergeBackResult {
  const gc = opts.gc ?? true;
  const wt = worktreePathFor(projectDir);

  // No isolated worktree (a non-git project degraded to running in-place, or
  // nothing was ever provisioned) → nothing to integrate.
  if (!existsSync(wt)) return { merged: false, reason: "no-worktree" };
  if (!isWorkTree(projectDir)) return { merged: false, reason: "no-git" };

  const projectHead = git(projectDir, ["rev-parse", "HEAD"]).stdout;

  // Stage everything the agent left, then commit only if the index actually
  // differs (a backend that committed its own work leaves a clean index but
  // an advanced detached HEAD — handled by the sha comparison below).
  git(wt, ["add", "-A"]);
  const indexDirty = !git(wt, ["diff", "--cached", "--quiet"]).ok; // exit 1 == dirty
  if (indexDirty) {
    git(wt, [
      "-c",
      "user.email=loom@localhost",
      "-c",
      "user.name=loom",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      `loom: ${taskId ?? "task"}`,
    ]);
  }

  const headSha = git(wt, ["rev-parse", "HEAD"]).stdout;
  if (headSha.length === 0) {
    return finishGc(projectDir, wt, gc, { merged: false, reason: "no-head" });
  }
  // Nothing changed relative to the task-start state → no branch worth making.
  if (headSha === projectHead) {
    return finishGc(projectDir, wt, gc, { merged: false, reason: "no-changes" });
  }

  const branch = branchNameFor(taskId ?? "task");
  const branched = git(projectDir, ["branch", "-f", branch, headSha]);
  if (!branched.ok) {
    return finishGc(projectDir, wt, gc, { merged: false, reason: "branch-failed" });
  }

  const files = parsePaths(
    git(projectDir, ["diff", "--name-only", projectHead, headSha]).stdout,
  );
  return finishGc(projectDir, wt, gc, {
    merged: true,
    branch,
    head_sha: headSha,
    files_changed: files,
  });
}

// Remove the project's worktree (and prune its admin entry). Safe to call
// when there is no worktree. The branch ref created above is NOT touched —
// it lives in the shared object store and survives the removal.
export function removeWorktree(projectDir: string): boolean {
  const wt = worktreePathFor(projectDir);
  if (!existsSync(wt)) {
    git(projectDir, ["worktree", "prune"]);
    return false;
  }
  git(projectDir, ["worktree", "remove", "--force", wt]);
  // Belt-and-suspenders if git left the directory behind.
  try {
    rmSync(wt, { recursive: true, force: true });
  } catch {
    /* a lingering dir is not fatal — prune below tidies the admin entry */
  }
  git(projectDir, ["worktree", "prune"]);
  return true;
}

// Startup GC: prune stale worktree admin entries, and remove THIS project's
// worktree when no task is live to own it (a previous run that died after
// finishing, or a rotated slot). Scoped to the single project — an age-based
// sweep across every project's worktrees is a follow-on.
export function sweepOrphanWorktree(
  projectDir: string,
  opts: { slotInProgress: boolean },
): { removed: boolean } {
  git(projectDir, ["worktree", "prune"]);
  if (opts.slotInProgress) return { removed: false };
  const wt = worktreePathFor(projectDir);
  if (!existsSync(wt)) return { removed: false };
  return { removed: removeWorktree(projectDir) };
}

function finishGc(
  projectDir: string,
  _wt: string,
  gc: boolean,
  result: MergeBackResult,
): MergeBackResult {
  if (!gc) return result;
  const removed = removeWorktree(projectDir);
  return { ...result, worktree_removed: removed };
}

function parsePaths(out: string): string[] {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}
