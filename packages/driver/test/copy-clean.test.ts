// `cleanLoomArtifacts` + the provision path that calls it. A fresh sandbox copy
// must NOT carry loom's own per-task state (under `.loom/`) or a prior task's
// leftover bundle artifacts (the agents write those under `.claude/` per their
// prompts) — otherwise an agent reviews the wrong thing and the real target
// goes untouched (the "stale workspace" bug). Loom config the next task reads
// (`.loom/loom.json` / `.loom/providers.json`) and the user's own `.claude/`
// files MUST survive. No mocks: a real temp tree + a real git repo.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { cleanLoomArtifacts } from "../src/copy.js";
import { provisionWorktree, worktreePathFor } from "../src/worktree.js";

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
}

// Seed the full spread: loom's runtime state under `.loom/` (DB + side-files,
// daemon log, exec prefs, history, transcripts) + the config the next task
// reads; and under `.claude/` the stale agent artifacts (plan / findings /
// legacy JSON state) plus the user's own Claude Code settings + commands.
function seedFootprint(dir: string): void {
  const loom = join(dir, ".loom");
  mkdirSync(join(loom, "daemon"), { recursive: true });
  mkdirSync(join(loom, "transcripts"), { recursive: true });
  mkdirSync(join(loom, "history"), { recursive: true });
  // loom-owned transient state — must be stripped
  writeFileSync(join(loom, "state.db"), "DB", "utf8");
  writeFileSync(join(loom, "state.db-wal"), "WAL", "utf8");
  writeFileSync(join(loom, "state.db-shm"), "SHM", "utf8");
  writeFileSync(join(loom, "daemon", "log.jsonl"), "{}\n", "utf8");
  writeFileSync(join(loom, "task-exec.json"), "{}", "utf8");
  writeFileSync(join(loom, "transcripts", "ar-old.json"), "{}", "utf8");
  writeFileSync(join(loom, "history", "t-old.db"), "OLD", "utf8");
  writeFileSync(join(loom, "history", "index.jsonl"), "{}\n", "utf8");
  // loom config the next task reads — must SURVIVE
  writeFileSync(join(loom, "loom.json"), "{}", "utf8");
  writeFileSync(join(loom, "providers.json"), "{}", "utf8");

  const claude = join(dir, ".claude");
  mkdirSync(join(claude, "commands"), { recursive: true });
  // stale prior-task bundle artifacts the agents wrote — must be stripped
  writeFileSync(join(claude, "plan.md"), "# old plan", "utf8");
  writeFileSync(join(claude, "findings.jsonl"), "{}\n", "utf8");
  writeFileSync(join(claude, "pipeline-state.json"), "{}", "utf8");
  writeFileSync(join(claude, "driver-state.json"), "{}", "utf8");
  // the user's own Claude Code config — must SURVIVE
  writeFileSync(join(claude, "settings.json"), "{}", "utf8");
  writeFileSync(join(claude, "commands", "task.md"), "cmd", "utf8");
}

function assertCleaned(dir: string): void {
  const loom = join(dir, ".loom");
  for (const gone of [
    "state.db", "state.db-wal", "state.db-shm", "daemon", "history", "transcripts",
    "task-exec.json",
  ]) {
    assert.equal(existsSync(join(loom, gone)), false, `.loom/${gone} should be removed`);
  }
  for (const kept of ["loom.json", "providers.json"]) {
    assert.equal(existsSync(join(loom, kept)), true, `.loom/${kept} should be kept`);
  }
  const claude = join(dir, ".claude");
  for (const gone of ["plan.md", "findings.jsonl", "pipeline-state.json", "driver-state.json"]) {
    assert.equal(existsSync(join(claude, gone)), false, `.claude/${gone} should be removed`);
  }
  for (const kept of ["settings.json", "commands"]) {
    assert.equal(existsSync(join(claude, kept)), true, `.claude/${kept} should be kept`);
  }
}

describe("cleanLoomArtifacts", () => {
  it("strips loom state + stale bundle artifacts but keeps config + user files", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-clean-"));
    try {
      seedFootprint(dir);
      cleanLoomArtifacts(dir);
      assertCleaned(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op when there is no footprint dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-clean-empty-"));
    try {
      assert.doesNotThrow(() => cleanLoomArtifacts(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("provisionWorktree — fresh copy is cleaned", () => {
  it("the sandbox copy carries no loom state / stale artifacts", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-wt-clean-"));
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "test@loom.local");
    git(dir, "config", "user.name", "loom test");
    git(dir, "config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "README.md"), "# project\n", "utf8");
    git(dir, "add", "README.md");
    git(dir, "commit", "-q", "-m", "seed");
    seedFootprint(dir);
    try {
      const prov = provisionWorktree(dir);
      assert.equal(prov.isolated, true);
      // The SOURCE tree is untouched — clean acts on the copy only.
      assert.equal(existsSync(join(dir, ".loom", "state.db")), true);
      // The COPY is clean of loom state + stale artifacts, config preserved.
      assertCleaned(prov.dir);
      // The real work target rode along in the copy.
      assert.equal(existsSync(join(prov.dir, "README.md")), true);
    } finally {
      rmSync(worktreePathFor(dir), { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
