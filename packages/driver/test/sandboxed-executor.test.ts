// The sandboxed-executor shell against a REAL git worktree + the `claude -p`
// runner's pure helpers. No mocks of git: every isolation test stands up a
// real temp repo and asserts where the agent's writes actually land.
//
// Coverage:
//   * an executor runs the injected backend in an ISOLATED worktree — the
//     write lands in the worktree, not the project's main tree;
//   * the worktree self-diff feeds files_created / files_modified into the
//     ExecutorResult (so the change-conditional reviewers fire);
//   * a re-resume (second execute, same project) REUSES the worktree;
//   * a non-git project DEGRADES to running in the project dir (no throw);
//   * buildClaudeArgs shapes a subscription `claude -p` argv (never --bare);
//   * parseClaudeResult extracts text / fails loudly on error envelopes.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { ProviderShuttleIntent } from "@loomfsm/kernel";

import {
  buildClaudeArgs,
  createSandboxedExecutor,
  parseClaudeResult,
  worktreePathFor,
} from "../src/index.js";

function intent(overrides: Partial<ProviderShuttleIntent> = {}): ProviderShuttleIntent {
  return {
    agent: "impl-1",
    agent_run_id: "ar-01HX0000000000000000000000",
    phase: "implementation",
    model: "default",
    prompt: "do the work",
    ...overrides,
  };
}

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
}

// A temp git repo with one commit (a seed file), so HEAD resolves and a
// worktree can branch from it.
function freshGitProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-wt-proj-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@loom.local");
  git(dir, "config", "user.name", "loom test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "seed.ts"), "export const seed = 1;\n", "utf8");
  git(dir, "add", "seed.ts");
  git(dir, "commit", "-q", "-m", "seed");
  return dir;
}

function cleanup(projectDir: string): void {
  // Remove the worktree first (its .git file points back into the repo), then
  // the project. force/recursive so a partially-written tree never blocks.
  const wt = worktreePathFor(projectDir);
  spawnSync("git", ["-C", projectDir, "worktree", "remove", "--force", wt], { encoding: "utf8" });
  rmSync(wt, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}

describe("createSandboxedExecutor — worktree isolation + self-diff", () => {
  it("runs the backend in an isolated worktree and self-diffs it into the carrier", async () => {
    const projectDir = freshGitProject();
    try {
      let sawWorktree = "";
      const executor = createSandboxedExecutor({
        project_dir: projectDir,
        runSpawn: async (_intent, worktreeDir) => {
          sawWorktree = worktreeDir;
          // The agent creates a new file and edits the seed — in the worktree.
          writeFileSync(join(worktreeDir, "added.ts"), "export const added = 1;\n", "utf8");
          writeFileSync(join(worktreeDir, "seed.ts"), "export const seed = 2;\n", "utf8");
          return "agent done";
        },
      });

      const result = await executor.execute(intent());

      assert.equal(result.agent_output, "agent done");
      // The backend ran in the deterministic worktree, NOT the project root.
      assert.equal(sawWorktree, worktreePathFor(projectDir));
      assert.notEqual(sawWorktree, projectDir);

      // Isolation: the write is in the worktree, the main tree is untouched.
      assert.ok(existsSync(join(sawWorktree, "added.ts")));
      assert.equal(existsSync(join(projectDir, "added.ts")), false);
      assert.equal(readFileSync(join(projectDir, "seed.ts"), "utf8"), "export const seed = 1;\n");

      // Self-diff fed the carrier without the backend reporting anything.
      assert.ok(result.files_created?.includes("added.ts"));
      assert.ok(result.files_modified?.includes("seed.ts"));
    } finally {
      cleanup(projectDir);
    }
  });

  it("reuses the worktree across a re-resume (a second executor instance)", async () => {
    const projectDir = freshGitProject();
    try {
      const wt = worktreePathFor(projectDir);

      // First drive: provisions the worktree and leaves a marker in it.
      const first = createSandboxedExecutor({
        project_dir: projectDir,
        runSpawn: async (_i, worktreeDir) => {
          writeFileSync(join(worktreeDir, "marker.txt"), "round-1", "utf8");
          return "one";
        },
      });
      await first.execute(intent());
      assert.ok(existsSync(join(wt, "marker.txt")));

      // Second drive (re-resume): a fresh executor for the same project must
      // REUSE the existing worktree, not recreate it — the marker survives.
      const second = createSandboxedExecutor({
        project_dir: projectDir,
        runSpawn: async (_i, worktreeDir) => {
          assert.equal(worktreeDir, wt);
          assert.equal(readFileSync(join(worktreeDir, "marker.txt"), "utf8"), "round-1");
          return "two";
        },
      });
      const out = await second.execute(intent());
      assert.equal(out.agent_output, "two");
    } finally {
      cleanup(projectDir);
    }
  });

  it("degrades to the project dir (no isolation) for a non-git project", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "loom-wt-nogit-"));
    try {
      let ranIn = "";
      let noticed = "";
      const executor = createSandboxedExecutor({
        project_dir: projectDir,
        onNotice: (m) => {
          noticed = m;
        },
        runSpawn: async (_i, worktreeDir) => {
          ranIn = worktreeDir;
          return "ok";
        },
      });

      const result = await executor.execute(intent());
      assert.equal(result.agent_output, "ok");
      // No git work tree → ran in the project dir, no self-diff, with a notice.
      assert.equal(ranIn, projectDir);
      assert.equal(result.files_created, undefined);
      assert.equal(result.files_modified, undefined);
      assert.match(noticed, /without isolation/);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe("claude -p runner helpers", () => {
  it("builds a subscription argv (json, model, permission-mode, no --bare)", () => {
    const args = buildClaudeArgs(
      intent({ model: "opus", system_prompt: "you are the implementer" }),
      "acceptEdits",
      undefined,
    );
    assert.deepEqual(args, [
      "-p",
      "do the work",
      "--output-format",
      "json",
      "--permission-mode",
      "acceptEdits",
      "--model",
      "opus",
      "--append-system-prompt",
      "you are the implementer",
    ]);
    // Never --bare: that would force ANTHROPIC_API_KEY instead of the login.
    assert.equal(args.includes("--bare"), false);
  });

  it("omits --model for the placeholder and --append-system-prompt when absent", () => {
    const args = buildClaudeArgs(intent({ model: "default" }), "acceptEdits", undefined);
    assert.equal(args.includes("--model"), false);
    assert.equal(args.includes("--append-system-prompt"), false);
  });

  it("passes --max-turns when set", () => {
    const args = buildClaudeArgs(intent(), "bypassPermissions", 12);
    assert.equal(args[args.indexOf("--max-turns") + 1], "12");
    assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
  });

  it("parses the final text out of a success result envelope", () => {
    const out = parseClaudeResult(
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "the answer" }),
    );
    assert.equal(out, "the answer");
  });

  it("throws on an error envelope and on non-JSON output", () => {
    assert.throws(
      () => parseClaudeResult(JSON.stringify({ is_error: true, subtype: "error_max_turns", result: "" })),
      /reported an error/,
    );
    assert.throws(() => parseClaudeResult("not json at all"), /parseable JSON/);
    assert.throws(() => parseClaudeResult(JSON.stringify({ type: "result" })), /'result' field/);
  });
});
