// resetWorktree — the headless-path GC that stops one task's edits from leaking
// into the next. The per-project copy is deterministic and REUSED across spawns
// of a task; a new task must NOT inherit the prior task's uncommitted edits, or
// its self-diff / review / acceptance would be contaminated. The drive resets it
// when it rotates one task out for another (auto-rotate / --replace).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { clonePathFor, provisionClone } from "../src/clone.js";
import { provisionWorktree, resetWorktree, worktreePathFor } from "../src/worktree.js";

function git(dir: string, ...args: string[]): void {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

function freshProject(): string {
  const d = mkdtempSync(join(tmpdir(), "loom-wt-test-"));
  git(d, "init", "-q");
  git(d, "config", "user.email", "t@loom.test");
  git(d, "config", "user.name", "loom test");
  git(d, "config", "commit.gpgsign", "false");
  writeFileSync(join(d, "a.txt"), "orig\n", "utf8");
  git(d, "add", "-A");
  git(d, "commit", "-q", "-m", "init");
  return d;
}

function cleanup(projectDir: string): void {
  resetWorktree(projectDir);
  rmSync(projectDir, { recursive: true, force: true });
}

describe("resetWorktree — discards the per-project copy so the next task starts clean", () => {
  it("is an idempotent no-op when no copy exists", () => {
    const dir = freshProject();
    try {
      assert.equal(existsSync(worktreePathFor(dir)), false);
      resetWorktree(dir);
      resetWorktree(dir);
      assert.equal(existsSync(worktreePathFor(dir)), false);
    } finally {
      cleanup(dir);
    }
  });

  it("a re-provision after reset does NOT inherit the prior task's edits", () => {
    const dir = freshProject();
    try {
      const wt1 = provisionWorktree(dir);
      assert.equal(wt1.isolated, true);
      // The prior task leaves uncommitted edits in the copy.
      writeFileSync(join(wt1.dir, "a.txt"), "task-1-edit\n", "utf8");
      writeFileSync(join(wt1.dir, "stray.txt"), "task-1 only\n", "utf8");

      // Rotate: reset, then re-provision for the NEXT task.
      resetWorktree(dir);
      assert.equal(existsSync(wt1.dir), false);

      const wt2 = provisionWorktree(dir);
      assert.equal(wt2.dir, wt1.dir, "same deterministic path");
      // Fresh from the project — none of task 1's edits survive.
      assert.equal(readFileSync(join(wt2.dir, "a.txt"), "utf8"), "orig\n");
      assert.equal(existsSync(join(wt2.dir, "stray.txt")), false);
    } finally {
      cleanup(dir);
    }
  });

  it("also resets the container backend's clone copy (so --docker tasks don't contaminate either)", () => {
    const dir = freshProject();
    try {
      const clone = provisionClone(dir);
      assert.equal(clone.dir, clonePathFor(dir));
      assert.equal(existsSync(clone.dir), true);
      writeFileSync(join(clone.dir, "stray.txt"), "task-1\n", "utf8");
      resetWorktree(dir);
      assert.equal(existsSync(clone.dir), false, "the container clone must be reset too");
    } finally {
      cleanup(dir);
    }
  });

  it("WITHOUT a reset, a re-provision reuses the copy (pins the contamination the reset prevents)", () => {
    const dir = freshProject();
    try {
      const wt1 = provisionWorktree(dir);
      writeFileSync(join(wt1.dir, "stray.txt"), "leaks\n", "utf8");
      // No reset → provisionWorktree reuses the existing copy, edits and all.
      const wt2 = provisionWorktree(dir);
      assert.equal(wt2.dir, wt1.dir);
      assert.equal(existsSync(join(wt2.dir, "stray.txt")), true, "reuse keeps prior edits — why reset is needed");
    } finally {
      cleanup(dir);
    }
  });
});
