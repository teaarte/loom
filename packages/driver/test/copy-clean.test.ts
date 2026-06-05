// `cleanLoomArtifacts` + the provision path that calls it. A fresh sandbox copy
// must NOT carry loom's own per-task state or a prior task's leftover bundle
// artifacts — otherwise an agent reviews the wrong thing and the real target
// goes untouched (the "stale workspace" bug). Loom config the next task reads,
// and the user's own `.claude/` files, MUST survive. No mocks: a real temp tree
// + a real git repo for the provision path.

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

// Seed a `.claude/` with the full spread: loom state (DB + side-files, daemon
// log, exec prefs, history), stale bundle artifacts (plan / findings / legacy
// JSON state), AND files that MUST survive (loom config, the user's own Claude
// Code settings + a project doc).
function seedClaude(dir: string): void {
  const claude = join(dir, ".claude");
  mkdirSync(join(claude, "daemon"), { recursive: true });
  mkdirSync(join(claude, "loom"), { recursive: true });
  mkdirSync(join(claude, "history"), { recursive: true });
  mkdirSync(join(claude, "commands"), { recursive: true });
  // loom-owned transient state — must be stripped
  writeFileSync(join(claude, "state.db"), "DB", "utf8");
  writeFileSync(join(claude, "state.db-wal"), "WAL", "utf8");
  writeFileSync(join(claude, "state.db-shm"), "SHM", "utf8");
  writeFileSync(join(claude, "daemon", "log.jsonl"), "{}\n", "utf8");
  writeFileSync(join(claude, "loom", "task-exec.json"), "{}", "utf8");
  writeFileSync(join(claude, "history", "t-old.db"), "OLD", "utf8");
  writeFileSync(join(claude, "history", "index.jsonl"), "{}\n", "utf8");
  // stale prior-task bundle artifacts — must be stripped
  writeFileSync(join(claude, "plan.md"), "# old plan", "utf8");
  writeFileSync(join(claude, "findings.jsonl"), "{}\n", "utf8");
  writeFileSync(join(claude, "pipeline-state.json"), "{}", "utf8");
  writeFileSync(join(claude, "driver-state.json"), "{}", "utf8");
  // must SURVIVE — loom config + the user's own Claude Code config
  writeFileSync(join(claude, "loom.json"), "{}", "utf8");
  writeFileSync(join(claude, "providers.json"), "{}", "utf8");
  writeFileSync(join(claude, "settings.json"), "{}", "utf8");
  writeFileSync(join(claude, "commands", "task.md"), "cmd", "utf8");
}

function assertCleaned(claude: string): void {
  for (const gone of [
    "state.db", "state.db-wal", "state.db-shm", "daemon", "loom", "history",
    "plan.md", "findings.jsonl", "pipeline-state.json", "driver-state.json",
  ]) {
    assert.equal(existsSync(join(claude, gone)), false, `${gone} should be removed`);
  }
  for (const kept of ["loom.json", "providers.json", "settings.json", "commands"]) {
    assert.equal(existsSync(join(claude, kept)), true, `${kept} should be kept`);
  }
}

describe("cleanLoomArtifacts", () => {
  it("strips loom state + stale bundle artifacts but keeps config + user files", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-clean-"));
    try {
      seedClaude(dir);
      cleanLoomArtifacts(dir);
      assertCleaned(join(dir, ".claude"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op when there is no .claude/ dir", () => {
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
    seedClaude(dir);
    try {
      const prov = provisionWorktree(dir);
      assert.equal(prov.isolated, true);
      // The SOURCE tree is untouched — clean acts on the copy only.
      assert.equal(existsSync(join(dir, ".claude", "state.db")), true);
      // The COPY is clean of loom state + stale artifacts, config preserved.
      assertCleaned(join(prov.dir, ".claude"));
      // The real work target rode along in the copy.
      assert.equal(existsSync(join(prov.dir, "README.md")), true);
    } finally {
      rmSync(worktreePathFor(dir), { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
