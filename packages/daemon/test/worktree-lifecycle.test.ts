// Worktree merge-back + GC over a REAL git repo. The executor provisions a
// detached worktree and leaves changes in it; the supervisor commits those to
// a `loom/<task>` branch (never auto-merged into the checked-out branch) and
// removes the worktree. The branch ref must OUTLIVE the worktree dir.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { clonePathFor, provisionClone, provisionWorktree, worktreePathFor } from "@loomfsm/driver";

import {
  commitToBranchMergeBack,
  commitToBranchMergeBackFromClone,
  removeClone,
  sweepOrphanClone,
  removeWorktree,
  sweepOrphanWorktree,
} from "../src/index.js";

function git(cwd: string, ...args: string[]): { ok: boolean; stdout: string } {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { ok: res.status === 0, stdout: typeof res.stdout === "string" ? res.stdout.trim() : "" };
}

function freshGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-daemon-mb-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@loom.local");
  git(dir, "config", "user.name", "loom test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "seed.ts"), "export const seed = 1;\n", "utf8");
  git(dir, "add", "seed.ts");
  git(dir, "commit", "-q", "-m", "seed");
  return dir;
}

function cleanup(dir: string): void {
  const wt = worktreePathFor(dir);
  spawnSync("git", ["-C", dir, "worktree", "remove", "--force", wt], { encoding: "utf8" });
  rmSync(wt, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}

describe("worktree-lifecycle — commit-to-branch merge-back", () => {
  it("commits the worktree's work to loom/<task> and GCs the worktree", () => {
    const dir = freshGitRepo();
    try {
      const wt = provisionWorktree(dir);
      assert.equal(wt.isolated, true);
      // The agent left an edit + a new file in the isolated worktree.
      writeFileSync(join(wt.dir, "generated.ts"), "export const x = 1;\n", "utf8");
      writeFileSync(join(wt.dir, "seed.ts"), "export const seed = 2;\n", "utf8");

      const result = commitToBranchMergeBack(dir, "task-abc-123");

      assert.equal(result.merged, true);
      assert.equal(result.branch, "loom/task-abc-123");
      assert.ok(result.files_changed?.includes("generated.ts"));
      assert.ok(result.files_changed?.includes("seed.ts"));
      assert.equal(result.worktree_removed, true);

      // The branch exists in the main repo and carries the work...
      assert.ok(git(dir, "rev-parse", "--verify", "loom/task-abc-123").ok);
      assert.equal(git(dir, "show", "loom/task-abc-123:generated.ts").stdout, "export const x = 1;");
      // ...but the checked-out tree was NOT touched (never auto-merged).
      assert.equal(existsSync(join(dir, "generated.ts")), false);
      assert.equal(readFileSync(join(dir, "seed.ts"), "utf8"), "export const seed = 1;\n");
      // The worktree dir is gone (GC ran); its branch survived it.
      assert.equal(existsSync(worktreePathFor(dir)), false);
    } finally {
      cleanup(dir);
    }
  });

  it("makes no branch when the worktree has no changes", () => {
    const dir = freshGitRepo();
    try {
      provisionWorktree(dir); // provision, but write nothing
      const result = commitToBranchMergeBack(dir, "task-empty");
      assert.equal(result.merged, false);
      assert.equal(result.reason, "no-changes");
      assert.equal(git(dir, "rev-parse", "--verify", "loom/task-empty").ok, false);
    } finally {
      cleanup(dir);
    }
  });

  it("is a clean no-op when there is no worktree (degraded / non-git path)", () => {
    const dir = freshGitRepo();
    try {
      const result = commitToBranchMergeBack(dir, "task-none");
      assert.equal(result.merged, false);
      assert.equal(result.reason, "no-worktree");
    } finally {
      cleanup(dir);
    }
  });

  it("carries gitignored files in the copy but keeps them OUT of the merge-back branch", () => {
    const dir = freshGitRepo();
    try {
      // Add a .gitignore so a generated dir is ignored, then provision a copy.
      writeFileSync(join(dir, ".gitignore"), "generated/\n", "utf8");
      spawnSync("git", ["-C", dir, "add", ".gitignore"], { encoding: "utf8" });
      spawnSync(
        "git",
        ["-C", dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "ignore"],
        { encoding: "utf8" },
      );
      const wt = provisionWorktree(dir);

      // The agent edits a TRACKED file and (re)generates a GITIGNORED one.
      writeFileSync(join(wt.dir, "seed.ts"), "export const seed = 2;\n", "utf8");
      mkdirSync(join(wt.dir, "generated"), { recursive: true });
      writeFileSync(join(wt.dir, "generated", "out.ts"), "export const gen = 1;\n", "utf8");

      const result = commitToBranchMergeBack(dir, "task-ign");
      assert.equal(result.merged, true);
      // The tracked edit is on the branch; the gitignored generated file is NOT.
      assert.ok(result.files_changed?.includes("seed.ts"));
      assert.equal(result.files_changed?.includes("generated/out.ts"), false);
      assert.equal(git(dir, "cat-file", "-e", "loom/task-ign:generated/out.ts").ok, false);
      assert.equal(git(dir, "show", "loom/task-ign:seed.ts").stdout, "export const seed = 2;");
    } finally {
      cleanup(dir);
    }
  });
});

describe("worktree-lifecycle — GC", () => {
  it("sweeps an orphaned worktree when no task is live, keeps it when one is", () => {
    const dir = freshGitRepo();
    try {
      provisionWorktree(dir);
      assert.equal(existsSync(worktreePathFor(dir)), true);

      // A live task owns the worktree → keep it.
      assert.deepEqual(sweepOrphanWorktree(dir, { slotInProgress: true }), { removed: false });
      assert.equal(existsSync(worktreePathFor(dir)), true);

      // No live task → it is an orphan → remove it.
      assert.deepEqual(sweepOrphanWorktree(dir, { slotInProgress: false }), { removed: true });
      assert.equal(existsSync(worktreePathFor(dir)), false);
    } finally {
      cleanup(dir);
    }
  });

  it("removeWorktree is safe when there is nothing to remove", () => {
    const dir = freshGitRepo();
    try {
      assert.equal(removeWorktree(dir), false);
    } finally {
      cleanup(dir);
    }
  });
});

function cleanupClone(dir: string): void {
  rmSync(clonePathFor(dir), { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}

describe("worktree-lifecycle — container clone merge-back", () => {
  it("EXTRACTS the clone's loom/<task> branch into the shared repo, checkout untouched", () => {
    const dir = freshGitRepo();
    try {
      const clone = provisionClone(dir);
      // The agent left an edit + a new file in the dedicated clone.
      writeFileSync(join(clone.dir, "generated.ts"), "export const x = 1;\n", "utf8");
      writeFileSync(join(clone.dir, "seed.ts"), "export const seed = 2;\n", "utf8");

      const result = commitToBranchMergeBackFromClone(dir, "task-abc-123");

      assert.equal(result.merged, true);
      assert.equal(result.branch, "loom/task-abc-123");
      assert.ok(result.files_changed?.includes("generated.ts"));
      assert.ok(result.files_changed?.includes("seed.ts"));
      assert.equal(result.worktree_removed, true);

      // The branch exists in the SHARED repo (extracted from the clone) and
      // carries the work...
      assert.ok(git(dir, "rev-parse", "--verify", "loom/task-abc-123").ok);
      assert.equal(git(dir, "show", "loom/task-abc-123:generated.ts").stdout, "export const x = 1;");
      // ...but the checked-out tree was NOT touched (never auto-merged).
      assert.equal(existsSync(join(dir, "generated.ts")), false);
      assert.equal(readFileSync(join(dir, "seed.ts"), "utf8"), "export const seed = 1;\n");
      // The clone dir is gone (GC ran); its extracted branch survived it.
      assert.equal(existsSync(clonePathFor(dir)), false);
    } finally {
      cleanupClone(dir);
    }
  });

  it("makes no branch when the clone has no changes", () => {
    const dir = freshGitRepo();
    try {
      provisionClone(dir); // provision, but write nothing
      const result = commitToBranchMergeBackFromClone(dir, "task-empty");
      assert.equal(result.merged, false);
      assert.equal(result.reason, "no-changes");
      assert.equal(git(dir, "rev-parse", "--verify", "loom/task-empty").ok, false);
    } finally {
      cleanupClone(dir);
    }
  });

  it("is a clean no-op when there is no clone", () => {
    const dir = freshGitRepo();
    try {
      const result = commitToBranchMergeBackFromClone(dir, "task-none");
      assert.equal(result.merged, false);
      assert.equal(result.reason, "no-clone");
    } finally {
      cleanupClone(dir);
    }
  });

  it("sweepOrphanClone removes an orphan clone only when no task is live", () => {
    const dir = freshGitRepo();
    try {
      provisionClone(dir);
      assert.deepEqual(sweepOrphanClone(dir, { slotInProgress: true }), { removed: false });
      assert.equal(existsSync(clonePathFor(dir)), true);
      assert.deepEqual(sweepOrphanClone(dir, { slotInProgress: false }), { removed: true });
      assert.equal(existsSync(clonePathFor(dir)), false);
      // Idempotent when nothing remains.
      assert.equal(removeClone(dir), false);
    } finally {
      cleanupClone(dir);
    }
  });
});
