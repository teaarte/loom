// Task sandbox provisioning for the (non-container) sandboxed executor.
//
// A headless spawn runs in an ISOLATED copy of the project so the agent's edits
// land in a separate working tree, never the project's main tree. The copy is a
// COPY-ON-WRITE full copy of the whole project directory — gitignored files,
// `node_modules`, generated code, AND `.git` — NOT a git checkout. A git
// checkout (the previous `git worktree add --detach`) carries only TRACKED
// files, so a real project's gitignored generated code / dependencies were
// ABSENT and a headless agent hit "path does not exist" on the very code its
// task was about. The full copy carries everything the agent needs to read; CoW
// keeps it instant and ~zero-disk (see `copy.ts`).
//
// The store is single-task per project, so there is exactly one copy per
// project; its path is a deterministic function of the project root, so a
// re-resume (a fresh executor instance for the same task) REUSES the existing
// copy instead of recreating it — idempotent, the same property the loop relies
// on for `agent_run_id` reuse.
//
// The copy lives OUTSIDE the repo (under the OS temp dir) so the main tree's
// `git status` stays clean. A project that is NOT a git work tree DEGRADES
// gracefully: with no git there is no baseline to self-diff and no branch to
// merge back to, so a copy would orphan the edits — instead the spawn runs in
// the project directory directly (no isolation) and the caller is told, mirroring
// the prior behaviour. A git project whose copy FAILS throws rather than
// silently mutating the live tree (the never-touch-the-checkout invariant).
//
// Merge-back of the copy's changes and GC belong to the long-lived supervisor,
// not here: this module only provisions and reuses. Because the copy is a
// SEPARATE repo (its own `.git`), merge-back EXTRACTS the work via a host-side
// `git fetch` from the copy (the same posture the container clone always used).
//
// Ambient I/O is fine — this is transport runtime OUTSIDE the kernel's replay
// graph.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { KernelError } from "@loomfsm/kernel";

import { cleanLoomArtifacts, clearGitLocks, copyTree, heavyCopyNotice } from "./copy.js";
import { gitBaselineRef } from "./git-delta.js";

export interface WorktreeProvision {
  // Where the spawn runs: an isolated full copy, or the project itself when the
  // project is not a git work tree (degraded, no isolation).
  dir: string;
  // The provision-time baseline ref to self-diff the copy against, or null when
  // there is no git work tree (then no self-diff is computed and the
  // server-side delta stands).
  baseline: string | null;
  // True when `dir` is an isolated copy distinct from the project root.
  isolated: boolean;
  // A non-fatal provisioning notice to surface (e.g. the heavy plain-copy
  // fallback when copy-on-write is unavailable). Omitted → nothing to say.
  notice?: string;
}

// The deterministic sandbox path for a project — a stable hash of the canonical
// project root under the OS temp dir, so re-resume finds the same copy.
// Exported for tests/inspection. (Name kept for API stability; it is now a full
// copy, not a git worktree.)
export function worktreePathFor(projectDir: string): string {
  const hash = createHash("sha1").update(resolve(projectDir)).digest("hex").slice(0, 16);
  return join(tmpdir(), `loom-wt-${hash}`);
}

// Provision (or reuse) the active task's isolated copy. Returns the directory
// the spawn should run in plus the baseline to self-diff against.
//
// Non-git project → degrade to running in the project dir (no isolation): there
// is no branch to merge a copy back to, so a copy would orphan the work.
// Git project whose copy fails → throw (never run in-place over a real repo).
// `forcePlainCopy` skips the CoW fast path (so the heavy fallback is testable).
export function provisionWorktree(
  projectDir: string,
  opts: { forcePlainCopy?: boolean } = {},
): WorktreeProvision {
  // HEAD at provision time — the ref the copy is checked out at and the baseline
  // the self-diff measures against. null/empty-tree for a non-git or commit-less
  // repo: there is then nothing to branch a sandbox from.
  const baseline = gitBaselineRef(projectDir);
  if (baseline === null) {
    return { dir: projectDir, baseline: null, isolated: false };
  }

  const dest = worktreePathFor(projectDir);
  if (existsSync(dest)) {
    // Reuse — idempotent across re-resume; do not re-copy.
    return { dir: dest, baseline, isolated: true };
  }

  const copied = copyTree(projectDir, dest, opts.forcePlainCopy === true ? { forcePlain: true } : {});
  if (!copied.ok) {
    throw new KernelError({
      code: "SANDBOX_PROVISION_FAILED",
      message: `could not provision an isolated copy of ${projectDir} for the spawn`,
      detail: { project_dir: projectDir, stderr_head: copied.stderr.slice(0, 500) },
    });
  }
  // Fresh copy only — strip loom's own state + a prior task's stale artifacts
  // so the spawn sees a clean `.claude/` working set (the reuse path above
  // returns before here, keeping the in-flight task's own working set intact).
  cleanLoomArtifacts(dest);
  clearGitLocks(dest);
  return {
    dir: dest,
    baseline,
    isolated: true,
    ...(copied.cow ? {} : { notice: heavyCopyNotice(projectDir, dest) }),
  };
}
