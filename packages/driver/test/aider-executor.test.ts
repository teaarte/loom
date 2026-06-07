// The Aider work-agent executor: its pure argv/usage helpers + the executor
// over a REAL git worktree with the backend runner injected (no real aider, no
// mocked git). Mirrors the sandboxed-executor test — every isolation assertion
// stands up a real temp repo and checks where the writes actually land.
//
// Coverage:
//   * buildAiderArgs shapes a headless, hermetic argv (--message / --yes-always,
//     auto-commit + repo-map + gitignore + analytics OFF, scratch redirected
//     OUT of the worktree, system_prompt folded into the message);
//   * parseAiderUsage reads aider's `Tokens:` / `Cost:` summary lines best-effort
//     (expands k/M; undefined when nothing matches — never throws);
//   * createAiderExecutor runs the injected backend in the ISOLATED worktree and
//     the self-diff feeds files_created / files_modified + forwards usage;
//   * the executor is idempotent (re-run safe in the deterministic worktree).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { ProviderShuttleIntent } from "@loomfsm/kernel";

import {
  buildAiderArgs,
  createAiderExecutor,
  parseAiderUsage,
  worktreePathFor,
  type SpawnUsage,
} from "../src/index.js";

function intent(overrides: Partial<ProviderShuttleIntent> = {}): ProviderShuttleIntent {
  return {
    agent: "worker-1",
    agent_run_id: "ar-01HX0000000000000000000000",
    phase: "implementation",
    model: "ollama_chat/qwen2.5-coder:32b",
    prompt: "add a subtract function",
    ...overrides,
  };
}

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
}

function freshGitProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-aider-proj-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@loom.local");
  git(dir, "config", "user.name", "loom test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "calc.py"), "def add(a, b):\n    return a + b\n", "utf8");
  git(dir, "add", "calc.py");
  git(dir, "commit", "-q", "-m", "seed");
  return dir;
}

function cleanup(projectDir: string): void {
  const wt = worktreePathFor(projectDir);
  spawnSync("git", ["-C", projectDir, "worktree", "remove", "--force", wt], { encoding: "utf8" });
  rmSync(wt, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}

describe("buildAiderArgs — headless, hermetic argv", () => {
  it("shapes a non-interactive single-turn invocation with side effects off", () => {
    const args = buildAiderArgs(intent(), "openrouter/deepseek-chat", {
      mapTokens: 0,
      scratchDir: "/tmp/scratch-x",
    });
    // model + message
    const mi = args.indexOf("--model");
    assert.equal(args[mi + 1], "openrouter/deepseek-chat");
    const msgi = args.indexOf("--message");
    assert.equal(args[msgi + 1], "add a subtract function");
    // non-interactive + hermetic flags
    for (const flag of [
      "--yes-always",
      "--no-stream",
      "--no-pretty",
      "--no-auto-commits",
      "--no-gitignore",
      "--no-check-update",
      "--analytics-disable",
      // under --yes-always, stop aider auto-scraping URLs in the task text and
      // auto-installing Playwright to do it
      "--no-detect-urls",
      "--disable-playwright",
    ]) {
      assert.ok(args.includes(flag), `expected ${flag} in argv`);
    }
    // repo map disabled (no .aider tags cache in the worktree)
    const ti = args.indexOf("--map-tokens");
    assert.equal(args[ti + 1], "0");
    // every scratch/history file is redirected OUT of the worktree
    for (const f of ["--chat-history-file", "--input-history-file", "--llm-history-file"]) {
      const idx = args.indexOf(f);
      assert.ok(idx >= 0, `expected ${f}`);
      assert.ok(args[idx + 1]?.startsWith("/tmp/scratch-x"), `${f} must live in the scratch dir`);
    }
  });

  it("folds a system_prompt into the message (aider has no --append-system-prompt)", () => {
    const args = buildAiderArgs(intent({ system_prompt: "You are precise." }), "ollama_chat/x", {
      mapTokens: 0,
      scratchDir: "/tmp/s",
    });
    const msg = args[args.indexOf("--message") + 1];
    assert.equal(msg, "You are precise.\n\nadd a subtract function");
  });

  it("appends extra args last", () => {
    const args = buildAiderArgs(intent(), "ollama_chat/x", {
      mapTokens: 0,
      scratchDir: "/tmp/s",
      extraArgs: ["--reasoning-effort", "high"],
    });
    assert.deepEqual(args.slice(-2), ["--reasoning-effort", "high"]);
  });
});

describe("parseAiderUsage — best-effort over summary lines", () => {
  it("parses tokens (expanding k/M) and cost", () => {
    const u = parseAiderUsage(
      "Tokens: 2.4k sent, 51 received.\nCost: $0.0012 message, $0.0150 session.\nApplied edit to calc.py",
    );
    assert.deepEqual(u?.tokens, { in: 2400, out: 51 });
    assert.equal(u?.cost_usd, 0.0012);
  });

  it("parses tokens with no cost line (local model)", () => {
    const u = parseAiderUsage("Tokens: 1.1M sent, 2.0k received.");
    assert.deepEqual(u?.tokens, { in: 1_100_000, out: 2000 });
    assert.equal(u?.cost_usd, undefined);
  });

  it("returns undefined when no summary line is present", () => {
    assert.equal(parseAiderUsage("Applied edit to calc.py\n"), undefined);
  });
});

describe("createAiderExecutor — worktree isolation + self-diff + usage", () => {
  it("runs the injected backend in the worktree and self-diffs it into the carrier", async () => {
    const projectDir = freshGitProject();
    try {
      let sawWorktree = "";
      const usages: SpawnUsage[] = [];
      const executor = createAiderExecutor({
        project_dir: projectDir,
        onUsage: (u) => usages.push(u),
        // Stand in for the real aider child: write into the worktree + report
        // an aider-shaped usage.
        runSpawn: async (_intent, worktreeDir) => {
          sawWorktree = worktreeDir;
          writeFileSync(join(worktreeDir, "util.py"), "def sub(a, b):\n    return a - b\n", "utf8");
          writeFileSync(join(worktreeDir, "calc.py"), "def add(a, b):\n    return a + b + 0\n", "utf8");
          return { output: "Applied edit to calc.py", usage: { tokens: { in: 2400, out: 51 } } };
        },
      });

      assert.equal(executor.idempotent, true);
      const result = await executor.execute(intent());

      assert.equal(result.agent_output, "Applied edit to calc.py");
      // ran in the deterministic worktree, not the project root
      assert.equal(sawWorktree, worktreePathFor(projectDir));
      // the live tree is untouched (the edit is isolated)
      assert.equal(readFileSync(join(projectDir, "calc.py"), "utf8"), "def add(a, b):\n    return a + b\n");
      // the self-diff fed the carrier honestly
      assert.deepEqual(result.files_created, ["util.py"]);
      assert.deepEqual(result.files_modified, ["calc.py"]);
      // usage forwarded to the result + the sink, stamped with spawn identity
      assert.deepEqual(result.usage?.tokens, { in: 2400, out: 51 });
      assert.deepEqual(usages, [
        { tokens: { in: 2400, out: 51 }, agent: "worker-1", model: "ollama_chat/qwen2.5-coder:32b" },
      ]);
    } finally {
      cleanup(projectDir);
    }
  });
});
