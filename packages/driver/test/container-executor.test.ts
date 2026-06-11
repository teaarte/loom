// The container backend: the pure docker-args builder + clone provisioning +
// usage parsing + the sandboxed shell over an INJECTED clone provisioner — all
// WITHOUT invoking docker. The clone tests stand up a real temp git repo (no
// mocks of git); the executor test injects the runner so the clone-provision +
// self-diff shell is exercised offline. A real end-to-end docker run is the
// separate env-gated e2e.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { ProviderShuttleIntent } from "@loomfsm/kernel";

import {
  buildDockerArgs,
  clonePathFor,
  createContainerExecutor,
  parseClaudeUsage,
  provisionClone,
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

function freshGitProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-clone-proj-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@loom.local");
  git(dir, "config", "user.name", "loom test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "seed.ts"), "export const seed = 1;\n", "utf8");
  git(dir, "add", "seed.ts");
  git(dir, "commit", "-q", "-m", "seed");
  return dir;
}

function cleanupClone(projectDir: string): void {
  rmSync(clonePathFor(projectDir), { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}

describe("buildDockerArgs — the spike-proven run posture", () => {
  it("mounts only the clone, runs non-root with a tmpfs HOME, forwards the token by name", () => {
    const args = buildDockerArgs(
      {
        image: "loom-claude:latest",
        cloneDir: "/tmp/loom-clone-abc",
        user: "501:20",
        network: "bridge",
        oauthTokenEnv: true,
      },
      ["claude", "-p", "do it", "--permission-mode", "bypassPermissions"],
    );

    // run --rm, non-root, writable tmpfs HOME kept OUT of the workspace.
    assert.equal(args[0], "run");
    assert.ok(args.includes("--rm"));
    // `-i` keeps stdin open so the prompt reaches the in-container `claude -p`
    // on stdin (off the host's `docker run … claude -p` command line).
    assert.ok(args.includes("-i"));
    assert.equal(args[args.indexOf("--user") + 1], "501:20");
    assert.ok(args.includes("--tmpfs"));
    assert.equal(args[args.indexOf("--tmpfs") + 1], "/home/app:rw,mode=1777");
    assert.equal(args[args.indexOf("-e") + 1], "HOME=/home/app");
    // ONLY the clone is mounted (rw), workdir is the mount.
    assert.ok(args.includes("-v"));
    assert.equal(args[args.indexOf("-v") + 1], "/tmp/loom-clone-abc:/workspace:rw");
    assert.equal(args[args.indexOf("-w") + 1], "/workspace");
    assert.equal(args[args.indexOf("--network") + 1], "bridge");
    // The token is forwarded by NAME (value never on argv).
    assert.ok(args.includes("CLAUDE_CODE_OAUTH_TOKEN"));
    assert.equal(args.join(" ").includes("="), true); // only HOME=… , never a token value
    assert.equal(args.some((a) => a.startsWith("CLAUDE_CODE_OAUTH_TOKEN=")), false);
    // The image precedes the command.
    const imageIdx = args.indexOf("loom-claude:latest");
    assert.ok(imageIdx > 0);
    assert.deepEqual(args.slice(imageIdx + 1), ["claude", "-p", "do it", "--permission-mode", "bypassPermissions"]);
  });

  it("omits --user when empty (trust the image USER) and --network when unset", () => {
    const args = buildDockerArgs({ image: "img", cloneDir: "/c", user: "" }, ["claude"]);
    assert.equal(args.includes("--user"), false);
    assert.equal(args.includes("--network"), false);
  });

  it("mounts the credential file read-only under HOME in file-credential mode", () => {
    const args = buildDockerArgs(
      { image: "img", cloneDir: "/c", credFileMount: "/home/u/.claude/.credentials.json" },
      ["claude"],
    );
    assert.ok(
      args.includes("/home/u/.claude/.credentials.json:/home/app/.claude/.credentials.json:ro"),
    );
    // No token env when mounting a file.
    assert.equal(args.includes("CLAUDE_CODE_OAUTH_TOKEN"), false);
  });
});

describe("clonePathFor — deterministic, distinct from the worktree", () => {
  it("is stable per project and never collides with the worktree path", () => {
    const dir = "/some/project";
    assert.equal(clonePathFor(dir), clonePathFor(dir));
    assert.notEqual(clonePathFor(dir), clonePathFor("/other/project"));
    assert.notEqual(clonePathFor(dir), worktreePathFor(dir));
    // Lives under the private per-user sandbox base as `clone-<hash>`.
    assert.match(clonePathFor(dir), /[/\\]loom-[^/\\]+[/\\]clone-[0-9a-f]+$/);
  });
});

describe("provisionClone — dedicated clone over a real repo", () => {
  it("clones the project (full git, baseline = HEAD) and reuses it on re-resume", () => {
    const projectDir = freshGitProject();
    try {
      const head = spawnSync("git", ["-C", projectDir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      const first = provisionClone(projectDir);
      assert.equal(first.dir, clonePathFor(projectDir));
      assert.equal(first.isolated, true);
      assert.equal(first.baseline, head);
      // It is a real, full git work tree with the project's content.
      assert.ok(existsSync(join(first.dir, ".git")));
      assert.equal(readFileSync(join(first.dir, "seed.ts"), "utf8"), "export const seed = 1;\n");

      // Re-resume: a second provision REUSES the clone (a marker survives).
      writeFileSync(join(first.dir, "marker.txt"), "round-1", "utf8");
      const second = provisionClone(projectDir);
      assert.equal(second.dir, first.dir);
      assert.equal(readFileSync(join(second.dir, "marker.txt"), "utf8"), "round-1");
    } finally {
      cleanupClone(projectDir);
    }
  });

  it("REFUSES (throws) on a non-git project — no honest degraded mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-clone-nogit-"));
    try {
      assert.throws(() => provisionClone(dir), /git repository/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const forcePlainCopy of [false, true]) {
    const label = forcePlainCopy ? "plain copy (forced fallback)" : "copy-on-write";
    it(`carries gitignored generated code + node_modules into the mounted copy (${label})`, () => {
      const dir = mkdtempSync(join(tmpdir(), "loom-clone-ign-"));
      git(dir, "init", "-q");
      git(dir, "config", "user.email", "test@loom.local");
      git(dir, "config", "user.name", "loom test");
      git(dir, "config", "commit.gpgsign", "false");
      writeFileSync(join(dir, ".gitignore"), "node_modules/\ngenerated/\n", "utf8");
      writeFileSync(join(dir, "seed.ts"), "export const seed = 1;\n", "utf8");
      git(dir, "add", ".gitignore", "seed.ts");
      git(dir, "commit", "-q", "-m", "seed");
      mkdirSync(join(dir, "generated"), { recursive: true });
      writeFileSync(join(dir, "generated", "client.d.ts"), "export type C = 1;\n", "utf8");
      mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "dep", "index.js"), "module.exports = 1;\n", "utf8");
      try {
        const clone = provisionClone(dir, { forcePlainCopy });
        assert.equal(clone.isolated, true);
        // The copy Docker mounts rw now carries the gitignored generated client
        // + deps — a `git clone --local` mount would have omitted both.
        assert.equal(readFileSync(join(clone.dir, "generated", "client.d.ts"), "utf8"), "export type C = 1;\n");
        assert.ok(existsSync(join(clone.dir, "node_modules", "dep", "index.js")));
        assert.ok(existsSync(join(clone.dir, ".git")));
      } finally {
        cleanupClone(dir);
      }
    });
  }
});

describe("parseClaudeUsage — usage/cost extraction from the claude -p envelope", () => {
  it("maps the usage block to neutral tokens + cost/turns/duration", () => {
    const usage = parseClaudeUsage(
      JSON.stringify({
        is_error: false,
        result: "done",
        num_turns: 2,
        duration_ms: 4433,
        total_cost_usd: 0.0367,
        usage: { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 18312 },
      }),
    );
    assert.deepEqual(usage, {
      tokens: { in: 3, out: 5, cached: 18312 },
      cost_usd: 0.0367,
      num_turns: 2,
      duration_ms: 4433,
    });
  });

  it("returns undefined when there is no usage and is null-safe on junk", () => {
    assert.equal(parseClaudeUsage(JSON.stringify({ is_error: false, result: "x" })), undefined);
    assert.equal(parseClaudeUsage("not json"), undefined);
  });
});

describe("createContainerExecutor — clone-provision + self-diff shell (injected runner)", () => {
  it("runs the backend in the clone, self-diffs it, surfaces usage, leaves the checkout untouched", async () => {
    const projectDir = freshGitProject();
    try {
      let sawDir = "";
      let noticedUsage: unknown = null;
      const executor = createContainerExecutor({
        project_dir: projectDir,
        image: "unused-in-this-test",
        onUsage: (u) => {
          noticedUsage = u;
        },
        // Inject the runner: write into the clone + report usage, no docker.
        runSpawn: async (_intent, cloneDir) => {
          sawDir = cloneDir;
          writeFileSync(join(cloneDir, "added.ts"), "export const added = 1;\n", "utf8");
          writeFileSync(join(cloneDir, "seed.ts"), "export const seed = 2;\n", "utf8");
          return { output: "agent done", usage: { tokens: { in: 1, out: 2 }, cost_usd: 0.01 } };
        },
      });

      const result = await executor.execute(intent());

      assert.equal(result.agent_output, "agent done");
      // Ran in the dedicated clone, NOT the project root.
      assert.equal(sawDir, clonePathFor(projectDir));
      assert.notEqual(sawDir, projectDir);
      // Self-diff fed the carrier from the clone.
      assert.ok(result.files_created?.includes("added.ts"));
      assert.ok(result.files_modified?.includes("seed.ts"));
      // Usage rode through to the result and the sink, stamped with identity.
      assert.deepEqual(result.usage, { tokens: { in: 1, out: 2 }, cost_usd: 0.01, agent: "impl-1", model: "default" });
      assert.deepEqual(noticedUsage, { tokens: { in: 1, out: 2 }, cost_usd: 0.01, agent: "impl-1", model: "default" });
      // Blast radius: the live checkout is untouched.
      assert.equal(existsSync(join(projectDir, "added.ts")), false);
      assert.equal(readFileSync(join(projectDir, "seed.ts"), "utf8"), "export const seed = 1;\n");
    } finally {
      cleanupClone(projectDir);
    }
  });
});
