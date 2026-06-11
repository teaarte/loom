// Dedicated-copy provisioning for the container backend.
//
// The container backend runs each spawn inside a container as the isolation
// boundary, with FULL git inside (status/diff/log/commit all work). What it
// operates on is a COPY-ON-WRITE full copy of the project, NOT the live working
// tree: a container that bind-mounted the live repo rw would let a
// `bypassPermissions` agent mutate the operator's real checkout and break the
// load-bearing invariant — "never touch the checked-out branch; work goes to
// `loom/<task>`". The copy plays the SAME role the (non-container) copy plays,
// returning the same `WorktreeProvision` shape so the sandboxed shell's self-diff
// + reuse logic runs over it unchanged, and Docker mounts THIS copy rw.
//
// The copy is a full copy of the whole directory (gitignored files,
// `node_modules`, generated code, AND `.git`) — NOT a `git clone --local`, which
// carries only tracked files and left a real project's gitignored generated code
// / dependencies absent inside the container. Copy-on-write keeps it cheap (see
// `copy.ts`); like the non-container copy it lives at a deterministic out-of-repo
// path so a re-resume REUSES it instead of recreating it.
//
// Unlike the non-container copy, which DEGRADES to running in-place on a non-git
// project, this REFUSES (throws) — container isolation is meaningless without a
// repo (no branch to extract the work to), and a silent unsandboxed run would
// violate the honesty rule. A non-git, non-container deployment uses the
// non-container backend, which degrades cleanly.
//
// Ambient I/O is fine — this is transport runtime OUTSIDE the kernel's replay
// graph.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { KernelError } from "@loomfsm/kernel";

import { cleanLoomArtifacts, clearGitLocks, copyTree, heavyCopyNotice } from "./copy.js";
import { gitBaselineRef } from "./git-delta.js";
import { ensureSandboxRoot, sandboxRoot } from "./sandbox-root.js";
import type { WorktreeProvision } from "./worktree.js";

// The deterministic copy path for a project — a stable hash of the canonical
// project root under the private per-user base, distinct from the non-container
// copy path so the two backends never collide. Exported for tests/inspection and
// for the merge-back, which extracts `loom/<task>` from this copy. (Name kept for
// API stability; it is now a full copy, not a `git clone --local`.)
export function clonePathFor(projectDir: string): string {
  const hash = createHash("sha1").update(resolve(projectDir)).digest("hex").slice(0, 16);
  return join(sandboxRoot(), `clone-${hash}`);
}

// Provision (or reuse) the active task's dedicated copy. Returns the copy
// directory plus the project's HEAD baseline to self-diff against. Throws when
// the project is not a git work tree, or when the copy cannot be created — the
// container backend has no honest degraded mode. `forcePlainCopy` skips the CoW
// fast path (so the heavy fallback is testable).
export function provisionClone(
  projectDir: string,
  opts: { forcePlainCopy?: boolean } = {},
): WorktreeProvision {
  // HEAD at provision time — the ref the copy is checked out at and the baseline
  // the self-diff measures against. The copy includes `.git`, so this sha
  // resolves inside the copy too.
  const baseline = gitBaselineRef(projectDir);
  if (baseline === null) {
    throw new KernelError({
      code: "CONTAINER_PROVISION_FAILED",
      message:
        `container isolation requires a git repository (copy provisioning), ` +
        `but ${projectDir} is not a git work tree`,
      detail: { project_dir: projectDir },
    });
  }

  const dest = clonePathFor(projectDir);
  if (existsSync(dest)) {
    // Reuse — idempotent across re-resume; do not re-copy.
    return { dir: dest, baseline, isolated: true };
  }

  // The private 0700 base must exist (and be verified ours) before the copy lands.
  ensureSandboxRoot();
  const copied = copyTree(projectDir, dest, opts.forcePlainCopy === true ? { forcePlain: true } : {});
  if (!copied.ok) {
    throw new KernelError({
      code: "CONTAINER_PROVISION_FAILED",
      message: `full copy of ${projectDir} for the container backend failed`,
      detail: { project_dir: projectDir, stderr_head: copied.stderr.slice(0, 500) },
    });
  }
  // Fresh copy only — strip loom's own state + a prior task's stale artifacts
  // so the containerized spawn sees a clean `.loom/` working set (the reuse
  // path above returns before here, keeping the in-flight working set intact).
  cleanLoomArtifacts(dest);
  clearGitLocks(dest);
  return {
    dir: dest,
    baseline,
    isolated: true,
    ...(copied.cow ? {} : { notice: heavyCopyNotice(projectDir, dest) }),
  };
}
