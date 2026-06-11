// A private, per-user base directory for task sandboxes (the worktree copies and
// the container clones), under the OS temp dir.
//
// Each sandbox path is a DETERMINISTIC hash of the project root, so a re-resume
// reuses the same copy. A bare `<tmp>/loom-wt-<hash>` is world-guessable AND, on
// a shared host, world-readable: another user could PRE-CREATE the deterministic
// path (so loom's `existsSync` reuse adopts a planted tree) or READ a copy that
// carries the project's gitignored secrets. Nesting every sandbox under a
// per-user `loom-<uid>` directory created 0700 closes both holes — another user
// can neither create the child inside a dir they cannot write, nor read it.
//
// Ambient I/O is fine — this is transport runtime OUTSIDE the kernel's replay
// graph.

import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { KernelError } from "@loomfsm/kernel";

// A stable per-user scope for the base-dir name: the uid on POSIX; the username
// as a fallback on platforms without getuid (where the per-user temp dir already
// isolates). Stable within a process, so the sandbox path stays deterministic.
function userScope(): string {
  const uid = process.getuid?.();
  if (uid !== undefined) return String(uid);
  try {
    return userInfo().username || "user";
  } catch {
    return "user";
  }
}

// The per-user private base. Pure (a function of the process identity only), so
// it can back the deterministic sandbox-path helpers without side effects.
export function sandboxRoot(): string {
  return join(tmpdir(), `loom-${userScope()}`);
}

// Create the base 0700 and verify it is genuinely OURS before any copy lands in
// it. A pre-existing entry that is a symlink, not a directory, or owned by a
// different user is refused (a planted decoy on a shared /tmp) rather than
// trusted. Called by the provisioners before the copy; idempotent.
export function ensureSandboxRoot(): string {
  const root = sandboxRoot();
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  } catch (err) {
    if ((err as { code?: string }).code !== "EEXIST") throw err;
  }
  const st = lstatSync(root);
  const uid = process.getuid?.();
  if (st.isSymbolicLink() || !st.isDirectory() || (uid !== undefined && st.uid !== uid)) {
    throw new KernelError({
      code: "SANDBOX_ROOT_UNSAFE",
      message: `the task sandbox base ${root} is not a directory owned by this user`,
      detail: { root },
    });
  }
  // Tighten perms in case a wide umask (or a pre-existing dir) left it group/other
  // accessible. Safe — we verified it is a real directory we own, not a symlink.
  chmodSync(root, 0o700);
  return root;
}
