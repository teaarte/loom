// The opencode work-agent executor: its pure argv/result helpers + the executor
// over a REAL git worktree with the backend runner injected (no real opencode,
// no mocked git). Mirrors the aider/sandboxed tests.
//
// Coverage:
//   * buildOpencodeArgs shapes a headless argv (run --format json
//     --dangerously-skip-permissions -m <model>, message trailing, system_prompt
//     folded);
//   * parseOpencodeResult joins `text` parts into the output and sums
//     `step-finish` tokens/cost into usage (tolerant of non-JSON lines; raw
//     stdout fallback when no text part; undefined usage when none);
//   * createOpencodeExecutor runs the injected backend in the ISOLATED worktree
//     and the self-diff feeds files_created / files_modified + forwards usage;
//   * the executor is idempotent.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { ProviderShuttleIntent } from "@loomfsm/kernel";

import {
  buildOpencodeArgs,
  createOpencodeExecutor,
  parseOpencodeResult,
  worktreePathFor,
  type SpawnUsage,
} from "../src/index.js";

function intent(overrides: Partial<ProviderShuttleIntent> = {}): ProviderShuttleIntent {
  return {
    agent: "worker-1",
    agent_run_id: "ar-01HX0000000000000000000000",
    phase: "implementation",
    model: "ollama/qwen2.5-coder:32b",
    prompt: "add a subtract function",
    ...overrides,
  };
}

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
}

function freshGitProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-oc-proj-"));
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

describe("buildOpencodeArgs — headless argv", () => {
  it("shapes a non-interactive json run with auto-approve, model, trailing message", () => {
    const args = buildOpencodeArgs(intent(), "openrouter/deepseek-chat");
    assert.equal(args[0], "run");
    assert.ok(args.includes("--dangerously-skip-permissions"));
    const fi = args.indexOf("--format");
    assert.equal(args[fi + 1], "json");
    const mi = args.indexOf("-m");
    assert.equal(args[mi + 1], "openrouter/deepseek-chat");
    // the message is the trailing positional
    assert.equal(args[args.length - 1], "add a subtract function");
  });

  it("folds a system_prompt into the message", () => {
    const args = buildOpencodeArgs(intent({ system_prompt: "Be precise." }), "ollama/x");
    assert.equal(args[args.length - 1], "Be precise.\n\nadd a subtract function");
  });

  it("pins --dir to the worktree (opencode otherwise resolves the project from the parent cwd)", () => {
    const args = buildOpencodeArgs(intent(), "ollama/x", { dir: "/tmp/loom-wt-abc" });
    const di = args.indexOf("--dir");
    assert.ok(di >= 0, "expected --dir");
    assert.equal(args[di + 1], "/tmp/loom-wt-abc");
    assert.equal(args[args.length - 1], "add a subtract function"); // message still trailing
  });

  it("appends extra args before the message", () => {
    const args = buildOpencodeArgs(intent(), "ollama/x", { extraArgs: ["--agent", "build"] });
    const ai = args.indexOf("--agent");
    assert.equal(args[ai + 1], "build");
    assert.equal(args[args.length - 1], "add a subtract function");
  });
});

describe("parseOpencodeResult — NDJSON event stream", () => {
  it("joins text parts and sums step-finish tokens + cost", () => {
    const stdout = [
      '{"type":"step_start","part":{}}',
      '{"type":"text","part":{"type":"text","text":"reading calc.py"}}',
      '{"type":"text","part":{"type":"text","text":"applied edit"}}',
      '{"type":"step_finish","part":{"tokens":{"input":9940,"output":51,"cache":{"read":7}},"cost":0.0012}}',
    ].join("\n");
    const r = parseOpencodeResult(stdout);
    assert.equal(r.output, "reading calc.py\napplied edit");
    assert.deepEqual(r.usage?.tokens, { in: 9940, out: 51, cached: 7 });
    assert.equal(r.usage?.cost_usd, 0.0012);
  });

  it("tolerates non-JSON lines and the hyphen 'step-finish' variant", () => {
    const stdout = [
      "warming up...",
      '{"type":"text","part":{"type":"text","text":"ok"}}',
      '{"type":"step-finish","part":{"tokens":{"input":10,"output":2}}}',
    ].join("\n");
    const r = parseOpencodeResult(stdout);
    assert.equal(r.output, "ok");
    assert.deepEqual(r.usage?.tokens, { in: 10, out: 2 });
    assert.equal(r.usage?.cost_usd, undefined);
  });

  it("falls back to raw stdout when there is no text part, and reports no usage", () => {
    const r = parseOpencodeResult("just some plain text, no events\n");
    assert.equal(r.output, "just some plain text, no events");
    assert.equal(r.usage, undefined);
  });
});

describe("createOpencodeExecutor — worktree isolation + self-diff + usage", () => {
  it("runs the injected backend in the worktree and self-diffs it into the carrier", async () => {
    const projectDir = freshGitProject();
    try {
      let sawWorktree = "";
      const usages: SpawnUsage[] = [];
      const executor = createOpencodeExecutor({
        project_dir: projectDir,
        onUsage: (u) => usages.push(u),
        runSpawn: async (_intent, worktreeDir) => {
          sawWorktree = worktreeDir;
          writeFileSync(join(worktreeDir, "util.py"), "def sub(a, b):\n    return a - b\n", "utf8");
          writeFileSync(join(worktreeDir, "calc.py"), "def add(a, b):\n    return a + b + 0\n", "utf8");
          return { output: "applied edit", usage: { tokens: { in: 9940, out: 51 }, cost_usd: 0 } };
        },
      });

      assert.equal(executor.idempotent, true);
      const result = await executor.execute(intent());

      assert.equal(result.agent_output, "applied edit");
      assert.equal(sawWorktree, worktreePathFor(projectDir));
      // live tree untouched
      assert.equal(readFileSync(join(projectDir, "calc.py"), "utf8"), "def add(a, b):\n    return a + b\n");
      assert.deepEqual(result.files_created, ["util.py"]);
      assert.deepEqual(result.files_modified, ["calc.py"]);
      assert.deepEqual(result.usage?.tokens, { in: 9940, out: 51 });
      assert.deepEqual(usages, [
        { tokens: { in: 9940, out: 51 }, cost_usd: 0, agent: "worker-1", model: "ollama/qwen2.5-coder:32b" },
      ]);
    } finally {
      cleanup(projectDir);
    }
  });
});
