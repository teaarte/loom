// Dedicated-clone provisioning for the container backend.
//
// The container backend runs each spawn inside a container as the isolation
// boundary, with FULL git inside (status/diff/log/commit all work). The git
// it operates on is a DEDICATED CLONE of the project, NOT the live working
// tree: a container that bind-mounted the live repo rw would let a
// `bypassPermissions` agent mutate the operator's real checkout and break the
// load-bearing invariant — "never touch the checked-out branch; work goes to
// `loom/<task>`". The clone plays the SAME role the detached worktree plays in
// the non-container backend (isolating the file tree from the live checkout),
// so it returns the same `WorktreeProvision` shape and the sandboxed shell's
// self-diff + reuse logic runs over it unchanged.
//
// `git clone --local` hardlinks the object store, so the clone is fast and
// cheap even on a large monorepo. Like the worktree, the clone lives at a
// deterministic out-of-repo path so a re-resume (a fresh executor instance for
// the same task) REUSES it instead of recreating it.
//
// Unlike the worktree, which DEGRADES to running in-place on a non-git
// project, the clone REFUSES (throws) — container isolation is meaningless
// without a repo to clone, and a silent unsandboxed run would violate the
// honesty rule (claim only the isolation actually provided). A non-git,
// non-container deployment uses the worktree backend, which degrades cleanly.
//
// Ambient I/O (spawnSync, tmpdir) is fine — this is transport runtime OUTSIDE
// the kernel's replay graph.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { KernelError } from "@loomfsm/kernel";

import { gitBaselineRef } from "./git-delta.js";
import type { WorktreeProvision } from "./worktree.js";

// The deterministic clone path for a project — a stable hash of the canonical
// project root under the OS temp dir, distinct from the worktree path so the
// two backends never collide. Exported for tests/inspection and for the
// merge-back, which extracts `loom/<task>` from this clone.
export function clonePathFor(projectDir: string): string {
  const hash = createHash("sha1").update(resolve(projectDir)).digest("hex").slice(0, 16);
  return join(tmpdir(), `loom-clone-${hash}`);
}

function runGit(args: string[]): { ok: boolean; stderr: string } {
  const res = spawnSync("git", args, { encoding: "utf8" });
  if (res.error !== undefined) return { ok: false, stderr: String(res.error) };
  return { ok: res.status === 0, stderr: typeof res.stderr === "string" ? res.stderr : "" };
}

// Provision (or reuse) the active task's dedicated clone. Returns the clone
// directory plus the project's HEAD baseline to self-diff against. Throws when
// the project is not a git work tree, or when the clone cannot be created —
// the container backend has no honest degraded mode.
export function provisionClone(projectDir: string): WorktreeProvision {
  // HEAD at provision time — the ref the clone is checked out at and the
  // baseline the self-diff measures against. The clone copies all refs/objects
  // so this sha resolves inside the clone too.
  const baseline = gitBaselineRef(projectDir);
  if (baseline === null) {
    throw new KernelError({
      code: "CONTAINER_PROVISION_FAILED",
      message:
        `container isolation requires a git repository (clone provisioning), ` +
        `but ${projectDir} is not a git work tree`,
      detail: { project_dir: projectDir },
    });
  }

  const clone = clonePathFor(projectDir);
  if (existsSync(clone)) {
    // Reuse — idempotent across re-resume; do not re-clone.
    return { dir: clone, baseline, isolated: true };
  }

  // `--local` hardlinks the object store (fast/cheap) and copies all refs; the
  // clone's working tree is checked out at the project's default-branch HEAD.
  const cloned = runGit(["clone", "--local", "--quiet", projectDir, clone]);
  if (!cloned.ok && !existsSync(clone)) {
    throw new KernelError({
      code: "CONTAINER_PROVISION_FAILED",
      message: `git clone --local of ${projectDir} failed`,
      detail: { project_dir: projectDir, stderr_head: cloned.stderr.slice(0, 500) },
    });
  }
  return { dir: clone, baseline, isolated: true };
}
