// End-to-end container backend over REAL docker + a REAL `claude -p` on the
// subscription. Gated: skipped unless LOOM_E2E_DOCKER=1, an image
// (LOOM_DOCKER_IMAGE), and a credential (CLAUDE_CODE_OAUTH_TOKEN, or a token in
// LOOM_E2E_TOKEN_FILE) are present — so the default `pnpm test` never spends
// subscription quota or needs Docker. When enabled it proves the real path:
// provision a dedicated clone, run `claude -p --permission-mode
// bypassPermissions` inside the container, and confirm the agent's write lands
// in the CLONE (not the live checkout), with usage reported.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { ProviderShuttleIntent } from "@loomfsm/kernel";

import { clonePathFor, createContainerExecutor } from "../src/index.js";

const ENABLED = process.env["LOOM_E2E_DOCKER"] === "1";

function resolveToken(): string | undefined {
  const env = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  if (env !== undefined && env.length > 0) return env;
  const file = process.env["LOOM_E2E_TOKEN_FILE"];
  if (file !== undefined && existsSync(file)) return readFileSync(file, "utf8").trim();
  return undefined;
}

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
}

function freshGitProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-e2e-proj-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@loom.local");
  git(dir, "config", "user.name", "loom test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "baseline\n", "utf8");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "baseline");
  return dir;
}

describe("createContainerExecutor — real docker e2e (gated)", () => {
  it(
    "runs bypass in-container, writes into the clone, reports cost, leaves the checkout untouched",
    { skip: ENABLED ? false : "set LOOM_E2E_DOCKER=1 (+ LOOM_DOCKER_IMAGE + a token) to run" },
    async () => {
      const image = process.env["LOOM_DOCKER_IMAGE"] ?? "loom-claude-spike:latest";
      const token = resolveToken();
      assert.ok(token !== undefined, "no credential — set CLAUDE_CODE_OAUTH_TOKEN or LOOM_E2E_TOKEN_FILE");

      const projectDir = freshGitProject();
      try {
        let usageSeen: unknown = null;
        const executor = createContainerExecutor({
          project_dir: projectDir,
          image,
          oauth_token: token,
          max_turns: 8,
          onUsage: (u) => {
            usageSeen = u;
          },
        });

        const intent: ProviderShuttleIntent = {
          agent: "impl-1",
          agent_run_id: "ar-01HXE2E0000000000000000000",
          phase: "implementation",
          model: "default",
          prompt:
            "Create a file named e2e.txt in the current directory containing exactly the line: ok. " +
            "Do not create anything else. Then stop.",
        };

        const result = await executor.execute(intent);

        // The agent's write landed in the dedicated clone, surfaced by self-diff.
        const clone = clonePathFor(projectDir);
        assert.ok(existsSync(join(clone, "e2e.txt")), "e2e.txt should exist in the clone");
        assert.ok(result.files_created?.includes("e2e.txt"));
        // Usage was parsed from the real envelope (cost billed to subscription).
        assert.ok(result.usage !== undefined, "usage should be reported");
        assert.ok((result.usage?.cost_usd ?? 0) > 0, "a real run reports a cost");
        assert.deepEqual(usageSeen, result.usage);
        // Blast radius: the live checkout is untouched.
        assert.equal(existsSync(join(projectDir, "e2e.txt")), false);
        assert.equal(readFileSync(join(projectDir, "README.md"), "utf8"), "baseline\n");
      } finally {
        rmSync(clonePathFor(projectDir), { recursive: true, force: true });
        rmSync(projectDir, { recursive: true, force: true });
      }
    },
  );
});
