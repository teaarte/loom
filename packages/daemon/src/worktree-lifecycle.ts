// Sandbox lifecycle — merge-back of the isolated copy's changes, plus GC.
//
// The sandboxed executor runs each headless spawn in an isolated COPY of the
// project (a copy-on-write full copy at a deterministic out-of-repo path —
// `worktreePathFor` for the non-container backend, `clonePathFor` for the
// container backend) and self-diffs it, but it never integrates or cleans the
// result — "isolate and account; do not auto-merge." On `complete` the
// supervisor here commits the copy's work to a branch `loom/<task_id>` (the
// branch ref outlives the copy dir), then removes the copy. It NEVER auto-merges
// into the operator's checked-out branch — the work lands reviewable on its own
// branch, and the operator merges (or discards) it deliberately.
//
// Because the isolated copy is a SEPARATE repo (its own `.git`, copied), the
// branch must be EXTRACTED into the shared repo via a host-side `git fetch` from
// the copy (into FETCH_HEAD, then a local branch) — a colon-refspec push would
// risk writing into the operator's checked-out repo. Both backends share this
// one path (`mergeBackFromCopy`); they differ only in WHERE the copy lives and
// how its dir is GC'd.
//
// Domain-blind: this reasons about git refs and paths only — never a bundle's
// vocabulary (the driver/daemon-leak gate stays green).

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

import { clonePathFor, worktreePathFor } from "@loomfsm/driver";

export interface MergeBackResult {
  // True when the copy's work was committed to a `loom/<task>` branch.
  merged: boolean;
  // Present when merged: the branch name, its tip sha, and the file set
  // (name-only) relative to the project's current HEAD — surfaced so the
  // operator can review before merging.
  branch?: string;
  head_sha?: string;
  files_changed?: string[];
  // The isolated copy (worktree-path or clone-path) was removed (GC ran).
  worktree_removed?: boolean;
  // When not merged, why: "no-worktree" / "no-clone" (never provisioned),
  // "no-git", "no-head", "no-changes", "branch-failed", or "fetch-failed".
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
export function branchNameFor(taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+/, "");
  return `loom/${safe.length > 0 ? safe : "task"}`;
}

// Integrate one isolated COPY's work into the project as a `loom/<task>` branch,
// then (by default) GC the copy. The copy is a separate repo, so the branch is
// EXTRACTED via a host-side fetch (never pushed into the checked-out repo).
// Idempotent: a re-run force-updates the branch and a missing copy is a clean
// no-op. Never throws on a git failure — it degrades to `{ merged:false, reason }`
// so a merge-back hiccup never crashes the supervisor mid-completion.
function mergeBackFromCopy(args: {
  projectDir: string;
  copyDir: string;
  taskId: string | null;
  gc: boolean;
  removeDir: (projectDir: string) => boolean;
  noCopyReason: string;
}): MergeBackResult {
  const { projectDir, copyDir, taskId, gc, removeDir, noCopyReason } = args;
  const finish = (result: MergeBackResult): MergeBackResult =>
    gc ? { ...result, worktree_removed: removeDir(projectDir) } : result;

  // No isolated copy (a non-git project degraded to running in-place, or nothing
  // was ever provisioned) → nothing to integrate, and nothing to GC.
  if (!existsSync(copyDir)) return { merged: false, reason: noCopyReason };
  if (!isWorkTree(projectDir)) return finish({ merged: false, reason: "no-git" });

  const projectHead = git(projectDir, ["rev-parse", "HEAD"]).stdout;

  // Stage everything the agent left (git respects .gitignore, so node_modules /
  // generated code carried by the copy are NOT committed), then commit only if
  // the index actually differs. A backend that committed its own work leaves a
  // clean index but an advanced HEAD — caught by the sha comparison below.
  // `core.hooksPath=/dev/null` neutralises any pre-commit hook the copied `.git`
  // carried (this internal merge-back commit must not run the project's hooks).
  git(copyDir, ["add", "-A"]);
  const indexDirty = !git(copyDir, ["diff", "--cached", "--quiet"]).ok; // exit 1 == dirty
  if (indexDirty) {
    git(copyDir, [
      "-c",
      "user.email=loom@localhost",
      "-c",
      "user.name=loom",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      `loom: ${taskId ?? "task"}`,
    ]);
  }

  const copyHead = git(copyDir, ["rev-parse", "HEAD"]).stdout;
  if (copyHead.length === 0) return finish({ merged: false, reason: "no-head" });
  // Nothing changed relative to the task-start state → no branch worth making.
  if (copyHead === projectHead) return finish({ merged: false, reason: "no-changes" });

  const branch = branchNameFor(taskId ?? "task");
  // Name the work in the copy, then EXTRACT it into the shared repo: a host-side
  // fetch into FETCH_HEAD (avoids a colon-refspec and never pushes into the
  // operator's checked-out repo), then create the local branch. The fetch copies
  // copyHead's objects into the shared store, so the diff below resolves there.
  const named = git(copyDir, ["branch", "-f", branch, copyHead]);
  if (!named.ok) return finish({ merged: false, reason: "branch-failed" });
  const fetched = git(projectDir, ["fetch", "--quiet", copyDir, branch]);
  if (!fetched.ok) return finish({ merged: false, reason: "fetch-failed" });
  const branched = git(projectDir, ["branch", "-f", branch, "FETCH_HEAD"]);
  if (!branched.ok) return finish({ merged: false, reason: "branch-failed" });

  const files = parsePaths(git(projectDir, ["diff", "--name-only", projectHead, copyHead]).stdout);
  return finish({ merged: true, branch, head_sha: copyHead, files_changed: files });
}

// Merge-back for the non-container backend (copy at `worktreePathFor`).
export function commitToBranchMergeBack(
  projectDir: string,
  taskId: string | null,
  opts: { gc?: boolean } = {},
): MergeBackResult {
  return mergeBackFromCopy({
    projectDir,
    copyDir: worktreePathFor(projectDir),
    taskId,
    gc: opts.gc ?? true,
    removeDir: removeWorktree,
    noCopyReason: "no-worktree",
  });
}

// Merge-back for the container backend (copy at `clonePathFor`). Identical
// posture; only the copy location and its GC differ.
export function commitToBranchMergeBackFromClone(
  projectDir: string,
  taskId: string | null,
  opts: { gc?: boolean } = {},
): MergeBackResult {
  return mergeBackFromCopy({
    projectDir,
    copyDir: clonePathFor(projectDir),
    taskId,
    gc: opts.gc ?? true,
    removeDir: removeClone,
    noCopyReason: "no-clone",
  });
}

// Remove the project's container-backend copy. A copy is a standalone repo (NOT
// a registered git worktree), so this is a plain directory removal. The extracted
// branch ref lives in the shared store and survives. Safe when there is none.
export function removeClone(projectDir: string): boolean {
  const clone = clonePathFor(projectDir);
  if (!existsSync(clone)) return false;
  try {
    rmSync(clone, { recursive: true, force: true });
  } catch {
    /* a lingering dir is not fatal */
  }
  return !existsSync(clone);
}

// Startup GC for the container copy, mirroring `sweepOrphanWorktree`: drop this
// project's copy when no task is live to own it (a previous container run that
// died after finishing). A no-op when none exists.
export function sweepOrphanClone(
  projectDir: string,
  opts: { slotInProgress: boolean },
): { removed: boolean } {
  if (opts.slotInProgress) return { removed: false };
  if (!existsSync(clonePathFor(projectDir))) return { removed: false };
  return { removed: removeClone(projectDir) };
}

// Remove the project's non-container copy. The copy is a plain directory (a
// standalone repo, NOT a registered git worktree), so this is a plain removal;
// `git worktree prune` then clears any LEGACY admin entry a pre-copy version may
// have left (harmless when there is none). The branch ref created above lives in
// the shared store and survives. Safe to call when there is nothing to remove.
export function removeWorktree(projectDir: string): boolean {
  const wt = worktreePathFor(projectDir);
  if (!existsSync(wt)) {
    git(projectDir, ["worktree", "prune"]);
    return false;
  }
  try {
    rmSync(wt, { recursive: true, force: true });
  } catch {
    /* a lingering dir is not fatal — prune below tidies any admin entry */
  }
  git(projectDir, ["worktree", "prune"]);
  return !existsSync(wt);
}

// Startup GC: remove THIS project's copy when no task is live to own it (a
// previous run that died after finishing, or a rotated slot), and prune any
// stale legacy worktree admin entries. Scoped to the single project — an
// age-based sweep across every project's copies is a follow-on.
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

function parsePaths(out: string): string[] {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// ----- ship: push + squash-merge the task branch ------------------------
//
// Merge-back (above) integrates the isolated copy's work onto a `loom/<task>`
// branch but NEVER touches the operator's checked-out branch — that is the
// sandbox invariant. Push and squash-merge are the ONE sanctioned write to the
// operator's branch / remote, taken DELIBERATELY (a button or a submit-time
// flag), never automatically by the sandbox. Both are git-ref/path reasoning
// only — domain-blind — and both refuse cleanly (a typed `reason`) rather than
// throw, so a control plane surfaces an actionable message.

export interface PushBranchResult {
  pushed: boolean;
  branch?: string;
  remote?: string;
  // When not pushed, why: "no-git" / "no-branch" / "no-remote" / "push-failed".
  reason?: string;
  // git's own message on a push failure (auth / non-fast-forward) — surfaced so
  // the operator sees WHY, not just that it failed.
  detail?: string;
}

// The remote to push to: an explicit override, else `origin` when present, else
// the single configured remote, else null (no remote → cannot push).
function resolveRemote(projectDir: string, override?: string): string | null {
  if (override !== undefined && override.length > 0) return override;
  const remotes = parsePaths(git(projectDir, ["remote"]).stdout);
  if (remotes.includes("origin")) return "origin";
  return remotes.length === 1 ? (remotes[0] as string) : remotes[0] ?? null;
}

function branchExists(projectDir: string, branch: string): boolean {
  return git(projectDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

// Push the task's `loom/<task>` branch to a remote (setting upstream), so the
// reviewable work leaves the host. Refuses cleanly when the project is not a git
// repo, the branch was never created (no changes / not yet merged-back), or no
// remote is configured. Never throws.
export function pushTaskBranch(
  projectDir: string,
  taskId: string | null,
  opts: { remote?: string } = {},
): PushBranchResult {
  if (!isWorkTree(projectDir)) return { pushed: false, reason: "no-git" };
  const branch = branchNameFor(taskId ?? "task");
  if (!branchExists(projectDir, branch)) return { pushed: false, branch, reason: "no-branch" };
  const remote = resolveRemote(projectDir, opts.remote);
  if (remote === null) return { pushed: false, branch, reason: "no-remote" };
  const res = git(projectDir, ["push", "--set-upstream", remote, branch]);
  if (!res.ok) return { pushed: false, branch, remote, reason: "push-failed", detail: res.stderr.trim() };
  return { pushed: true, branch, remote };
}

export interface SquashMergeResult {
  merged: boolean;
  branch?: string;
  // The branch the work was squash-merged INTO — the operator's current checkout.
  into?: string;
  head_sha?: string;
  files_changed?: string[];
  // When not merged, why: "no-git" / "no-branch" / "detached-head" /
  // "dirty-tree" / "no-changes" / "merge-conflict" / "commit-failed".
  reason?: string;
  detail?: string;
}

// Squash-merge the task's `loom/<task>` branch into the operator's CURRENT
// checked-out branch (one commit, the change as a unit). This is the one write
// to the operator's branch, so it is conservative: it refuses on a non-git repo,
// a missing branch, a detached HEAD, OR a dirty working tree (never merge over
// uncommitted operator work). On a conflict it hard-resets back to the
// pre-merge HEAD so the tree is never left half-merged. Never throws.
export function squashMergeTaskBranch(projectDir: string, taskId: string | null): SquashMergeResult {
  if (!isWorkTree(projectDir)) return { merged: false, reason: "no-git" };
  const branch = branchNameFor(taskId ?? "task");
  if (!branchExists(projectDir, branch)) return { merged: false, branch, reason: "no-branch" };
  const into = git(projectDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout;
  if (into.length === 0) return { merged: false, branch, reason: "detached-head" };
  if (git(projectDir, ["status", "--porcelain"]).stdout.length > 0) {
    return { merged: false, branch, into, reason: "dirty-tree" };
  }
  const before = git(projectDir, ["rev-parse", "HEAD"]).stdout;

  // `--squash` stages the branch's net change without recording a merge parent;
  // `--no-commit` keeps it explicit. A conflict leaves the index dirty, so reset
  // hard back to `before` to restore a clean tree before reporting.
  const squashed = git(projectDir, ["merge", "--squash", "--no-commit", branch]);
  if (!squashed.ok) {
    git(projectDir, ["reset", "--hard", before]);
    return { merged: false, branch, into, reason: "merge-conflict", detail: squashed.stderr.trim() };
  }
  // Nothing to commit → the branch added nothing over HEAD.
  if (git(projectDir, ["diff", "--cached", "--quiet"]).ok) {
    git(projectDir, ["reset", "--hard", before]);
    return { merged: false, branch, into, reason: "no-changes" };
  }
  const committed = git(projectDir, [
    "-c", "user.email=loom@localhost",
    "-c", "user.name=loom",
    "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=/dev/null",
    "commit",
    "-m",
    `loom: squash-merge ${branch}`,
  ]);
  if (!committed.ok) {
    git(projectDir, ["reset", "--hard", before]);
    return { merged: false, branch, into, reason: "commit-failed", detail: committed.stderr.trim() };
  }
  const head = git(projectDir, ["rev-parse", "HEAD"]).stdout;
  const files = parsePaths(git(projectDir, ["diff", "--name-only", before, head]).stdout);
  return { merged: true, branch, into, head_sha: head, files_changed: files };
}
