// Ship: push the task branch + squash-merge it into the operator's checkout —
// the two sanctioned writes to the operator's branch / remote. Over REAL git
// repos: a clean squash-merge lands the work as one commit, and every refusal
// (non-git / no-branch / dirty tree / no-remote) returns a typed reason rather
// than touching anything.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { provisionWorktree, worktreePathFor } from "@loomfsm/driver";

import { commitToBranchMergeBack, pushTaskBranch, squashMergeTaskBranch } from "../src/index.js";

function git(cwd: string, ...args: string[]): { ok: boolean; stdout: string } {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { ok: res.status === 0, stdout: typeof res.stdout === "string" ? res.stdout.trim() : "" };
}

function freshGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-ship-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@loom.local");
  git(dir, "config", "user.name", "loom test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "seed.ts"), "export const seed = 1;\n", "utf8");
  git(dir, "add", "seed.ts");
  git(dir, "commit", "-q", "-m", "seed");
  return dir;
}

// Run a task's work in the worktree and merge it back to a `loom/<task>` branch,
// so push/merge have a branch to act on. Returns the task id used.
function seedTaskBranch(dir: string, taskId: string): void {
  const wt = provisionWorktree(dir);
  writeFileSync(join(wt.dir, "feature.ts"), "export const feature = 1;\n", "utf8");
  const mb = commitToBranchMergeBack(dir, taskId);
  assert.equal(mb.merged, true, "merge-back should create the branch");
}

function cleanup(dir: string): void {
  spawnSync("git", ["-C", dir, "worktree", "remove", "--force", worktreePathFor(dir)], { encoding: "utf8" });
  rmSync(worktreePathFor(dir), { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}

describe("squashMergeTaskBranch", () => {
  it("squash-merges the task branch into the current checkout as one commit", () => {
    const dir = freshGitRepo();
    try {
      const before = git(dir, "rev-parse", "HEAD").stdout;
      seedTaskBranch(dir, "t-merge-1");
      const r = squashMergeTaskBranch(dir, "t-merge-1");
      assert.equal(r.merged, true);
      assert.equal(r.into, "main");
      assert.deepEqual(r.files_changed, ["feature.ts"]);
      // The file landed in the live checkout, as a NEW commit on main.
      assert.equal(readFileSync(join(dir, "feature.ts"), "utf8"), "export const feature = 1;\n");
      assert.notEqual(git(dir, "rev-parse", "HEAD").stdout, before);
      // Exactly one new commit (a squash, not a merge with two parents).
      assert.equal(git(dir, "rev-list", "--count", `${before}..HEAD`).stdout, "1");
    } finally {
      cleanup(dir);
    }
  });

  it("refuses a dirty working tree (never merges over uncommitted work)", () => {
    const dir = freshGitRepo();
    try {
      seedTaskBranch(dir, "t-dirty");
      writeFileSync(join(dir, "seed.ts"), "export const seed = 999;\n", "utf8"); // uncommitted edit
      const r = squashMergeTaskBranch(dir, "t-dirty");
      assert.equal(r.merged, false);
      assert.equal(r.reason, "dirty-tree");
      // The operator's edit is untouched.
      assert.equal(readFileSync(join(dir, "seed.ts"), "utf8"), "export const seed = 999;\n");
    } finally {
      cleanup(dir);
    }
  });

  it("refuses when the task branch was never created", () => {
    const dir = freshGitRepo();
    try {
      const r = squashMergeTaskBranch(dir, "t-nope");
      assert.equal(r.merged, false);
      assert.equal(r.reason, "no-branch");
    } finally {
      cleanup(dir);
    }
  });

  it("refuses a non-git directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-ship-nogit-"));
    try {
      const r = squashMergeTaskBranch(dir, "t-x");
      assert.equal(r.merged, false);
      assert.equal(r.reason, "no-git");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pushTaskBranch", () => {
  it("refuses when no remote is configured", () => {
    const dir = freshGitRepo();
    try {
      seedTaskBranch(dir, "t-no-remote");
      const r = pushTaskBranch(dir, "t-no-remote");
      assert.equal(r.pushed, false);
      assert.equal(r.reason, "no-remote");
    } finally {
      cleanup(dir);
    }
  });

  it("refuses when the task branch was never created", () => {
    const dir = freshGitRepo();
    try {
      const r = pushTaskBranch(dir, "t-missing");
      assert.equal(r.pushed, false);
      assert.equal(r.reason, "no-branch");
    } finally {
      cleanup(dir);
    }
  });

  it("pushes the branch to a configured remote", () => {
    const dir = freshGitRepo();
    const bare = mkdtempSync(join(tmpdir(), "loom-ship-bare-"));
    try {
      spawnSync("git", ["init", "-q", "--bare", bare], { encoding: "utf8" });
      git(dir, "remote", "add", "origin", bare);
      seedTaskBranch(dir, "t-push");
      const r = pushTaskBranch(dir, "t-push");
      assert.equal(r.pushed, true);
      assert.equal(r.remote, "origin");
      assert.equal(r.branch, "loom/t-push");
      // The branch is really on the remote.
      assert.ok(existsSync(bare));
      assert.equal(git(bare, "rev-parse", "--verify", "--quiet", "refs/heads/loom/t-push").ok, true);
    } finally {
      cleanup(dir);
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("refuses a non-git directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-ship-nogit-"));
    try {
      const r = pushTaskBranch(dir, "t-x");
      assert.equal(r.pushed, false);
      assert.equal(r.reason, "no-git");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
