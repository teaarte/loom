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
  defaultRateLimitDetector,
  parseClaudeResult,
  provisionWorktree,
  worktreePathFor,
} from "../src/index.js";
import { EXECUTOR_EMPTY_DIFF } from "../src/executor-errors.js";

import { mkdirSync } from "node:fs";

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
  // The sandbox is a standalone copy (not a registered worktree); a plain
  // recursive removal suffices. force/recursive so a partial tree never blocks.
  rmSync(worktreePathFor(projectDir), { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}

function headOf(dir: string): string {
  return spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
}

// A git project that ALSO carries gitignored generated code + a stand-in
// `node_modules` (committed only `.gitignore` + `seed.ts`) — the real-project
// shape a tracked-only checkout would have left incomplete.
function gitProjectWithIgnored(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-wt-ign-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@loom.local");
  git(dir, "config", "user.name", "loom test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\ngenerated/\n", "utf8");
  writeFileSync(join(dir, "seed.ts"), "export const seed = 1;\n", "utf8");
  git(dir, "add", ".gitignore", "seed.ts");
  git(dir, "commit", "-q", "-m", "seed");
  // Gitignored, uncommitted — present on disk, ABSENT from a git checkout.
  mkdirSync(join(dir, "generated", "prisma"), { recursive: true });
  writeFileSync(join(dir, "generated", "prisma", "index.d.ts"), "export type P = 1;\n", "utf8");
  mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "dep", "index.js"), "module.exports = 1;\n", "utf8");
  return dir;
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

  it("a spawn inside the copy can READ a gitignored generated file (the root-cause fix)", async () => {
    const projectDir = gitProjectWithIgnored();
    try {
      let readBack = "";
      const executor = createSandboxedExecutor({
        project_dir: projectDir,
        runSpawn: async (_i, dir) => {
          // The generated Prisma client is gitignored — a tracked-only checkout
          // would 'path does not exist' here; the full copy carries it.
          readBack = readFileSync(join(dir, "generated", "prisma", "index.d.ts"), "utf8");
          return "ok";
        },
      });
      await executor.execute(intent());
      assert.equal(readBack, "export type P = 1;\n");
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

describe("createSandboxedExecutor — leaves the textual diff for the reviewers", () => {
  it("writes the implementer's changes to .loom/work/diff.txt in the sandbox", async () => {
    const projectDir = freshGitProject();
    try {
      const executor = createSandboxedExecutor({
        project_dir: projectDir,
        runSpawn: async (_i, worktreeDir) => {
          // The implementer edits the seed and adds a new (untracked) file.
          writeFileSync(join(worktreeDir, "seed.ts"), "export const seed = 99;\n", "utf8");
          writeFileSync(join(worktreeDir, "added.ts"), "export const added = 1;\n", "utf8");
          return "implemented";
        },
      });

      await executor.execute(intent());

      const diffPath = join(worktreePathFor(projectDir), ".loom", "work", "diff.txt");
      assert.ok(existsSync(diffPath), "diff.txt must exist in the sandbox work area");
      const diff = readFileSync(diffPath, "utf8");
      // The tracked edit shows as a hunk; the untracked file shows as an add.
      assert.match(diff, /seed\.ts/);
      assert.match(diff, /-export const seed = 1;/);
      assert.match(diff, /\+export const seed = 99;/);
      assert.match(diff, /added\.ts/);
      assert.match(diff, /\+export const added = 1;/);
      // It must NOT have been written to the real project tree.
      assert.equal(existsSync(join(projectDir, ".loom", "work", "diff.txt")), false);
    } finally {
      cleanup(projectDir);
    }
  });

  it("a later reviewer spawn reads the diff the implementer left in the same worktree", async () => {
    const projectDir = freshGitProject();
    try {
      // First spawn = implementer: changes the tree (its execute leaves diff.txt).
      const impl = createSandboxedExecutor({
        project_dir: projectDir,
        runSpawn: async (_i, dir) => {
          writeFileSync(join(dir, "seed.ts"), "export const seed = 7;\n", "utf8");
          return "done";
        },
      });
      await impl.execute(intent({ agent: "implementer" }));

      // Second spawn = reviewer (a fresh executor instance, same project ⇒ same
      // reused worktree): it reads the diff the implementer left.
      let reviewerSawDiff = "";
      const reviewer = createSandboxedExecutor({
        project_dir: projectDir,
        runSpawn: async (_i, dir) => {
          reviewerSawDiff = readFileSync(join(dir, ".loom", "work", "diff.txt"), "utf8");
          return "reviewed";
        },
      });
      await reviewer.execute(intent({ agent: "logic-reviewer", phase: "implementation" }));

      assert.match(reviewerSawDiff, /\+export const seed = 7;/);
    } finally {
      cleanup(projectDir);
    }
  });

  it("writes no diff.txt for a non-git project (no baseline)", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "loom-wt-nogit-diff-"));
    try {
      const executor = createSandboxedExecutor({
        project_dir: projectDir,
        runSpawn: async () => "ok",
      });
      await executor.execute(intent());
      assert.equal(existsSync(join(projectDir, ".loom", "work", "diff.txt")), false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe("createSandboxedExecutor — seeds static files into the sandbox", () => {
  it("copies a seed dir into the sandbox before the first spawn runs", async () => {
    const projectDir = freshGitProject();
    const refsSrc = mkdtempSync(join(tmpdir(), "loom-refs-src-"));
    writeFileSync(join(refsSrc, "redis.md"), "# redis patterns\n", "utf8");
    writeFileSync(join(refsSrc, "api-design.md"), "# api design\n", "utf8");
    try {
      let sawRef = "";
      const executor = createSandboxedExecutor({
        project_dir: projectDir,
        sandbox_seed: [{ src: refsSrc, rel: ".loom/work/refs" }],
        runSpawn: async (_i, dir) => {
          // The seed is present BEFORE the spawn runs (an agent can read it).
          sawRef = readFileSync(join(dir, ".loom", "work", "refs", "redis.md"), "utf8");
          return "ok";
        },
      });
      await executor.execute(intent());

      assert.equal(sawRef, "# redis patterns\n");
      const wt = worktreePathFor(projectDir);
      assert.ok(existsSync(join(wt, ".loom", "work", "refs", "api-design.md")));
      // The operator's real tree is never seeded.
      assert.equal(existsSync(join(projectDir, ".loom", "work", "refs", "redis.md")), false);
    } finally {
      cleanup(projectDir);
      rmSync(refsSrc, { recursive: true, force: true });
    }
  });

  it("does not seed an un-isolated (non-git) project — never writes into the real tree", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "loom-wt-nogit-seed-"));
    const refsSrc = mkdtempSync(join(tmpdir(), "loom-refs-src2-"));
    writeFileSync(join(refsSrc, "x.md"), "x\n", "utf8");
    try {
      const executor = createSandboxedExecutor({
        project_dir: projectDir,
        sandbox_seed: [{ src: refsSrc, rel: ".loom/work/refs" }],
        runSpawn: async () => "ok",
      });
      await executor.execute(intent());
      assert.equal(existsSync(join(projectDir, ".loom", "work", "refs", "x.md")), false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(refsSrc, { recursive: true, force: true });
    }
  });
});

describe("provisionWorktree — full copy carries gitignored files + deps", () => {
  for (const forcePlainCopy of [false, true]) {
    const label = forcePlainCopy ? "plain copy (forced fallback)" : "copy-on-write";
    it(`carries gitignored generated code + node_modules + .git into the copy (${label})`, () => {
      const projectDir = gitProjectWithIgnored();
      try {
        const wt = provisionWorktree(projectDir, { forcePlainCopy });
        assert.equal(wt.isolated, true);
        assert.equal(wt.dir, worktreePathFor(projectDir));
        assert.equal(wt.baseline, headOf(projectDir));

        // The gitignored generated client + a stand-in node_modules dep are
        // PRESENT in the copy — a tracked-only checkout would have omitted them.
        assert.equal(
          readFileSync(join(wt.dir, "generated", "prisma", "index.d.ts"), "utf8"),
          "export type P = 1;\n",
        );
        assert.ok(existsSync(join(wt.dir, "node_modules", "dep", "index.js")));
        // .git was copied too (merge-back needs it); HEAD resolves in the copy.
        assert.ok(existsSync(join(wt.dir, ".git")));
        const copyHead = spawnSync("git", ["-C", wt.dir, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).stdout.trim();
        assert.equal(copyHead, wt.baseline);

        // The real tree is never touched by provisioning.
        assert.equal(readFileSync(join(projectDir, "seed.ts"), "utf8"), "export const seed = 1;\n");
      } finally {
        cleanup(projectDir);
      }
    });
  }
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
      "--output-format",
      "json",
      "--permission-mode",
      "acceptEdits",
      "--model",
      "opus",
      "--append-system-prompt",
      "you are the implementer",
    ]);
    // The prompt is NEVER on argv — it rides on stdin (off `ps aux`).
    assert.equal(args.includes("do the work"), false);
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

  it("folds the raw stdout/stderr into the parse-failure message (diagnosable)", () => {
    try {
      parseClaudeResult("I gave up after many failing tool calls — no JSON here", undefined, {
        stderr: "permission denied: cd /real/tree",
        exitCode: 0,
      });
      assert.fail("expected a throw");
    } catch (err) {
      assert.equal((err as { code?: string }).code, "EXECUTOR_OUTPUT_INVALID");
      // The raw output rides in the message, not just the structured detail.
      assert.match((err as Error).message, /no JSON here/);
      assert.match((err as Error).message, /permission denied/);
    }
  });

  it("classifies a non-JSON rate-limit notice as EXECUTOR_RATE_LIMITED, not OUTPUT_INVALID", () => {
    try {
      parseClaudeResult("You've hit your weekly limit · resets Monday", defaultRateLimitDetector, {
        exitCode: 0,
      });
      assert.fail("expected a throw");
    } catch (err) {
      assert.equal((err as { code?: string }).code, "EXECUTOR_RATE_LIMITED");
    }
  });
});

// ============================================================================
// expects_edits — a file-editing agent that changed nothing fails fast
// ============================================================================

describe("createSandboxedExecutor — empty self-diff fail-fast", () => {
  // A backend run that produces NO change to the worktree (the F1 "I'll read
  // the plan first" → 0 edits class of no-op).
  const runNoEdits = async (): Promise<string> => "I considered the task but wrote nothing.";

  it("throws EXECUTOR_EMPTY_DIFF when an edit-expecting agent's self-diff is empty", async () => {
    const projectDir = freshGitProject();
    try {
      const executor = createSandboxedExecutor({
        project_dir: projectDir,
        runSpawn: runNoEdits,
        expects_edits: () => true,
      });
      await assert.rejects(
        executor.execute(intent()),
        (err: unknown) => {
          assert.equal((err as { code?: string }).code, EXECUTOR_EMPTY_DIFF);
          assert.match((err as Error).message, /empty diff/);
          return true;
        },
      );
    } finally {
      cleanup(projectDir);
    }
  });

  it("does NOT throw when the edit-expecting agent actually changed a file", async () => {
    const projectDir = freshGitProject();
    try {
      const executor = createSandboxedExecutor({
        project_dir: projectDir,
        runSpawn: async (_intent, worktreeDir) => {
          writeFileSync(join(worktreeDir, "added.ts"), "export const added = 1;\n", "utf8");
          return "done";
        },
        expects_edits: () => true,
      });
      const result = await executor.execute(intent());
      assert.equal(result.agent_output, "done");
      assert.deepEqual(result.files_created, ["added.ts"]);
    } finally {
      cleanup(projectDir);
    }
  });

  it("exempts a decision agent (expects_edits false) — an empty diff is fine", async () => {
    const projectDir = freshGitProject();
    try {
      const executor = createSandboxedExecutor({
        project_dir: projectDir,
        runSpawn: runNoEdits,
        expects_edits: () => false,
      });
      const result = await executor.execute(intent({ agent: "logic-reviewer" }));
      assert.equal(result.agent_output, "I considered the task but wrote nothing.");
      assert.equal(result.files_modified, undefined);
      assert.equal(result.files_created, undefined);
    } finally {
      cleanup(projectDir);
    }
  });

  it("applies no empty-diff check at all when the predicate is omitted (default)", async () => {
    const projectDir = freshGitProject();
    try {
      const executor = createSandboxedExecutor({ project_dir: projectDir, runSpawn: runNoEdits });
      const result = await executor.execute(intent());
      assert.equal(result.agent_output, "I considered the task but wrote nothing.");
    } finally {
      cleanup(projectDir);
    }
  });
});
