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

import { capDiffText, gitBaselineRef, gitDelta, gitDiffText } from "../src/git-delta.js";

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

  it("never counts loom's own .loom/ footprint, even when the project does NOT gitignore it", () => {
    const dir = freshDir();
    try {
      initRepo(dir);
      git(dir, "commit", "-q", "--allow-empty", "-m", "baseline");
      const baseline = gitBaselineRef(dir);

      // The project does NOT gitignore .loom/ (the dogfooded case). loom seeds
      // its knowledge refs and renders diff.txt under .loom/work/ in the
      // worktree; none of it is the agent's change to the project.
      write(dir, ".loom/work/refs/api-design.md", "# seeded ref\n");
      write(dir, ".loom/work/refs/error-handling.md", "# seeded ref\n");
      write(dir, ".loom/work/diff.txt", "diff --git a/x b/x\n");
      write(dir, ".loom/state.db", "binary-ish\n");
      // …and one REAL change the agent made.
      write(dir, "src/real.ts", "export const z = 1\n");

      const delta = gitDelta(dir, baseline);
      assert.ok(delta !== null);
      // Only the real source file is created — the entire .loom/ tree is excluded.
      assert.deepEqual(delta?.created, ["src/real.ts"]);
      assert.deepEqual(delta?.modified, []);

      // The rendered textual diff likewise carries the real change and NONE of
      // the .loom/ artifacts (no seeded refs, and no diff.txt referencing itself).
      const text = gitDiffText(dir, baseline);
      assert.ok(text !== null);
      assert.ok(text.includes("src/real.ts"), "real change must be in the diff");
      assert.ok(!text.includes(".loom/"), "no .loom/ artifact may leak into the diff");
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

// ============================================================================
// Pathological-diff cap — a normal diff is untouched; a multi-MB diff is
// truncated per file with a COMPLETE per-file stat list so no change is hidden.
// ============================================================================

describe("git-delta — capDiffText", () => {
  // Build one file's add-only section with `adds` `+` lines, padded so the
  // fixture crosses the 256 KB pathological threshold.
  function addOnlySection(path: string, adds: number): string {
    const lines = [
      `diff --git a/${path} b/${path}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${path}`,
      `@@ -0,0 +1,${adds} @@`,
    ];
    for (let i = 0; i < adds; i += 1) lines.push(`+line ${i} ${"x".repeat(600)}`);
    return lines.join("\n");
  }

  it("returns a normal (sub-threshold) diff verbatim", () => {
    const small =
      "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n";
    assert.ok(Buffer.byteLength(small, "utf8") <= 256 * 1024);
    assert.equal(capDiffText(small), small);
  });

  it("truncates each file's hunk to its first 300 changed lines + a complete stat list", () => {
    // Two pathological files: 400 and 350 added lines.
    const diff = `${addOnlySection("src/a.ts", 400)}\n${addOnlySection("src/b.ts", 350)}\n`;
    assert.ok(Buffer.byteLength(diff, "utf8") > 256 * 1024, "fixture must be pathological");

    const capped = capDiffText(diff);

    // Each file kept EXACTLY its first 300 added content lines (300 + 300).
    const keptAdds = (capped.match(/^\+line \d+ /gm) ?? []).length;
    assert.equal(keptAdds, 600, "300 changed lines kept per file");

    // One omission marker per truncated file, naming the file to open.
    assert.equal((capped.match(/diff truncated:/g) ?? []).length, 2);
    assert.ok(capped.includes("first 300 changed lines"));
    assert.ok(capped.includes("open src/a.ts in the worktree"));

    // The COMPLETE per-file stat list carries each file's FULL counts (400 / 350),
    // not the truncated 300 — so no change is invisible.
    assert.ok(capped.includes("complete per-file change summary"));
    assert.ok(capped.includes("+400 -0\tsrc/a.ts"));
    assert.ok(capped.includes("+350 -0\tsrc/b.ts"));
  });

  it("counts removals too and is byte-stable on repeat", () => {
    const big = ["diff --git a/c.ts b/c.ts", "--- a/c.ts", "+++ b/c.ts", "@@ -1,800 +1,1 @@"];
    for (let i = 0; i < 800; i += 1) big.push(`-gone ${i} ${"y".repeat(600)}`);
    big.push("+kept");
    const diff = `${big.join("\n")}\n`;
    assert.ok(Buffer.byteLength(diff, "utf8") > 256 * 1024);

    const a = capDiffText(diff);
    const b = capDiffText(diff);
    assert.equal(a, b, "deterministic");
    // 800 removals + 1 addition reported in full; the hunk truncated at 300 changed.
    assert.ok(a.includes("+1 -800\tc.ts"));
    assert.equal((a.match(/^-gone \d+ /gm) ?? []).length, 300, "300 changed lines kept");
  });
});
