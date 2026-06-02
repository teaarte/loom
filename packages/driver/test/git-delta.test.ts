// Server-side file-delta computation against a REAL git work tree.
//
// The whole point of this channel is to stay honest when a run COMMITS its
// work: a working-tree-vs-HEAD diff goes empty the moment the change lands
// in a commit, so the change-conditional reviewers it feeds silently turn
// into no-ops. These tests commit files to a real temp repo and assert the
// baseline-relative delta still sees them — and the `redden-on-revert` case
// pins the bug by showing the old HEAD-based query returns nothing for the
// exact same committed change.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { gitBaselineRef, gitDelta } from "../src/git-delta.js";

// Run git for test setup; throws on failure (a broken fixture must fail
// loudly, not silently produce a misleading assertion).
function git(dir: string, ...args: string[]): string {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

function initRepo(dir: string): void {
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@loom.test");
  git(dir, "config", "user.name", "loom test");
  // Deterministic default branch regardless of the host git config.
  git(dir, "checkout", "-q", "-b", "main");
}

function write(dir: string, rel: string, body: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "loom-gitdelta-"));
}

describe("git-delta — baseline ref capture", () => {
  it("returns null for a directory that is not a git work tree", () => {
    const dir = freshDir();
    try {
      assert.equal(gitBaselineRef(dir), null);
      // …and a null baseline yields no delta at all.
      assert.equal(gitDelta(dir, null), null);
      assert.equal(gitDelta(dir, gitBaselineRef(dir)), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the commit sha for a repo with history", () => {
    const dir = freshDir();
    try {
      initRepo(dir);
      git(dir, "commit", "-q", "--allow-empty", "-m", "root");
      const head = git(dir, "rev-parse", "HEAD");
      assert.equal(gitBaselineRef(dir), head);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the empty-tree ref for an initialized repo with no commits", () => {
    const dir = freshDir();
    try {
      initRepo(dir);
      const baseline = gitBaselineRef(dir);
      assert.equal(baseline, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
      // Committing against that baseline surfaces the first-commit files.
      write(dir, "src/App.tsx", "export const App = () => null\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "first");
      const delta = gitDelta(dir, baseline);
      assert.ok(delta !== null);
      assert.deepEqual(delta?.modified, ["src/App.tsx"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("git-delta — honest delta of committed + uncommitted + untracked work", () => {
  it("catches COMMITTED files the working-tree-vs-HEAD diff would miss", () => {
    const dir = freshDir();
    try {
      initRepo(dir);
      git(dir, "commit", "-q", "--allow-empty", "-m", "baseline");
      const baseline = gitBaselineRef(dir);
      assert.ok(baseline !== null);

      // The run commits its work — HEAD now contains it.
      write(dir, "src/App.tsx", "export const App = () => <div/>\n");
      write(dir, "src/components/Button.tsx", "export const Button = () => null\n");
      write(dir, "src/auth/login.ts", "export const login = () => {}\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "implementer work (committed)");

      const delta = gitDelta(dir, baseline);
      assert.ok(delta !== null);
      assert.deepEqual(
        [...(delta?.modified ?? [])].sort(),
        ["src/App.tsx", "src/auth/login.ts", "src/components/Button.tsx"],
      );

      // redden-on-revert: the OLD driver query (working-tree-vs-HEAD) is
      // empty for the very same committed change. If someone reverts the
      // baseline approach back to HEAD, `delta.modified` collapses to this
      // empty set and the change-conditional reviewers go dark again.
      const headBased = git(dir, "diff", "--name-only", "HEAD");
      assert.equal(headBased, "", "working-tree-vs-HEAD is empty once work is committed");
      assert.notDeepEqual(
        delta?.modified,
        [],
        "baseline-relative delta must NOT be empty for committed work",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("splits uncommitted edits into modified and untracked files into created", () => {
    const dir = freshDir();
    try {
      initRepo(dir);
      write(dir, "src/existing.ts", "export const x = 1\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "baseline with one tracked file");
      const baseline = gitBaselineRef(dir);

      // Modify a tracked file WITHOUT committing, and add an untracked one.
      write(dir, "src/existing.ts", "export const x = 2\n");
      write(dir, "src/brand-new.ts", "export const y = 3\n");

      const delta = gitDelta(dir, baseline);
      assert.ok(delta !== null);
      assert.deepEqual(delta?.modified, ["src/existing.ts"]);
      assert.deepEqual(delta?.created, ["src/brand-new.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors .gitignore for untracked files (build artifacts never count)", () => {
    const dir = freshDir();
    try {
      initRepo(dir);
      write(dir, ".gitignore", "dist/\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "baseline");
      const baseline = gitBaselineRef(dir);

      write(dir, "dist/bundle.js", "compiled\n");
      write(dir, "src/real.ts", "export const z = 1\n");

      const delta = gitDelta(dir, baseline);
      assert.ok(delta !== null);
      assert.deepEqual(delta?.created, ["src/real.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
