// `drive()` to `complete` THROUGH the sandboxed executor, over a REAL git
// project + a REAL SQLite store. This is the headless `loom run` path proven
// end-to-end deterministically (with a stub backend in place of `claude -p`):
//
//   * the loop spins spawn -> execute -> deliver -> ... -> terminal;
//   * the agent's worktree write is SELF-DIFFED by the executor and folded
//     into delivery, so `state.files_created` carries it — i.e. the
//     change-conditional reviewers would fire, not silently no-op;
//   * the main tree stays untouched (isolation).
//
// A second, OPT-IN test drives the REAL `claude -p` backend (env-gated like
// the ollama loop) — skipped unless LOOM_E2E_CLAUDE=1, since it needs a
// signed-in Claude Code and bills the subscription.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildVocabularies,
  closeDb,
  openDb,
  type Agent,
  type Bundle,
  type GateRole,
  type LLMProvider,
  type Policy,
  type PolicyName,
  type Registry,
  type Stage,
} from "@loomfsm/kernel";
import { reconcileExtensions, type DiscoveredManifest } from "@loomfsm/loader";

import {
  createClaudeCodeExecutor,
  createSandboxedExecutor,
  drive,
  readState,
  worktreePathFor,
} from "../src/index.js";

const FIXED_NOW = "2026-06-02T10:00:00.000Z";

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
}

// A spawn->finalize fixture registry with a stub shuttle provider (the
// injected executor runs spawns; the provider only shapes the directive).
function fixtureRegistry(): Registry {
  const stages: Record<string, Stage> = {
    "spawn-1": { kind: "spawn", name: "spawn-1", phase: "work", agent: "impl-1" },
    "finalize-1": { kind: "finalize", name: "finalize-1" },
  };
  const agents: Agent[] = [
    { name: "impl-1", template_path: "templates/impl-1.md", output_kind: "nonreview" },
  ];
  const flow = ["spawn-1", "finalize-1"];
  const bundle: Bundle = {
    name: "code-fixture",
    version: "1.0.0",
    description: "driver sandboxed-drive fixture bundle",
    phases: ["work"],
    default_flow: "standard",
    default_gate_policies: {} as Record<GateRole, PolicyName>,
    gate_roles: {},
    agents,
    stages,
    flows: { standard: flow },
    hooks: [],
    invariants: [],
  };
  const provider: LLMProvider = {
    name: "stub",
    capabilities: { execution: "shuttle", idempotent_spawn: true, reports_usage: false },
    async spawn() {
      throw new Error("the injected executor runs spawns, not the provider");
    },
  };
  const policyFactories = new Map<PolicyName, () => Policy>();
  policyFactories.set("human", () => () => ({ type: "human-required", reason: "test" }));
  return {
    bundle,
    agents: new Map(agents.map((a) => [a.name, a])),
    stages: new Map(Object.entries(stages)),
    flows: new Map([["standard", flow]]),
    hooks: [],
    invariants: [],
    mcp_clients: new Map(),
    providers: {
      resolve: () => provider,
      all: [provider],
      health_check_all: Promise.resolve([{ name: provider.name, healthy: true }]),
    },
    policyFactories,
    vocabularies: buildVocabularies(bundle),
  };
}

function bundleManifest(): DiscoveredManifest {
  return {
    path: "/fixture/bundle/code-fixture",
    raw: {
      manifest_version: "1.0",
      name: "code-fixture",
      display_name: "code-fixture",
      description: "fixture bundle",
      version: "1.0.0",
      kind: "bundle",
      publisher: "@loom",
      capabilities: [],
      requires: { kernel_api: "^3.0.0" },
    },
  };
}

// A temp project that is BOTH a SQLite store and a git repo with one commit.
async function freshGitProject(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "loom-drive-wt-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@loom.local");
  git(dir, "config", "user.name", "loom test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "seed.ts"), "export const seed = 1;\n", "utf8");
  git(dir, "add", "seed.ts");
  git(dir, "commit", "-q", "-m", "seed");
  openDb(dir);
  await reconcileExtensions({
    manifests: [bundleManifest()],
    project_dir: dir,
    now: FIXED_NOW as never,
  });
  return dir;
}

function cleanup(dir: string): void {
  try {
    closeDb(dir);
  } catch {
    /* ignore */
  }
  const wt = worktreePathFor(dir);
  spawnSync("git", ["-C", dir, "worktree", "remove", "--force", wt], { encoding: "utf8" });
  rmSync(wt, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}

describe("drive — through the sandboxed executor (real git + SQLite)", () => {
  it("drives to complete; the worktree self-diff feeds the carrier", async () => {
    const dir = await freshGitProject();
    try {
      const executor = createSandboxedExecutor({
        project_dir: dir,
        runSpawn: async (_intent, worktreeDir) => {
          // The agent creates a file in the worktree.
          writeFileSync(join(worktreeDir, "generated.ts"), "export const x = 1;\n", "utf8");
          return "implemented";
        },
      });

      const outcome = await drive(dir, {
        executor,
        resolveRegistry: () => fixtureRegistry(),
        task: "build the thing",
        client_idempotency_uuid: "cidem-sandboxed",
      });

      assert.equal(outcome.kind, "complete");
      const state = await readState(dir);
      assert.equal(state.status, "completed");
      // The self-diff fed the file into delivery — a thin executor that
      // dropped it would leave the diff-gated reviewers silent. Reverting the
      // executor's gitDelta call reddens this.
      assert.ok(
        state.files_created.includes("generated.ts"),
        `expected generated.ts in files_created, got ${JSON.stringify(state.files_created)}`,
      );
      // Isolation: the file lives in the worktree, not the project main tree.
      assert.ok(existsSync(join(worktreePathFor(dir), "generated.ts")));
      assert.equal(existsSync(join(dir, "generated.ts")), false);
    } finally {
      cleanup(dir);
    }
  });

  it("an edit-expecting agent that changes nothing fails fast, retries once, then parks", async () => {
    const dir = await freshGitProject();
    try {
      let runs = 0;
      const executor = createSandboxedExecutor({
        project_dir: dir,
        // The agent produces output but never edits the worktree (the no-op
        // class of failure). expects_edits flags impl-1 as a file-editing agent.
        runSpawn: async () => {
          runs += 1;
          return "I read the plan but wrote no code.";
        },
        expects_edits: (intent) => intent.agent === "impl-1",
      });

      const outcome = await drive(dir, {
        executor,
        resolveRegistry: () => fixtureRegistry(),
        task: "build the thing",
        client_idempotency_uuid: "cidem-empty-diff",
        // One retry: attempt 1 (empty) is retried, attempt 2 (empty) parks.
        max_executor_retries: 1,
      });

      assert.equal(outcome.kind, "error");
      if (outcome.kind === "error") {
        // The typed empty-diff code SURVIVES the retry budget (it is in the
        // surfaceable set): the supervisor needs the code intact to park the
        // task instead of re-driving it as a generic transient failure.
        assert.equal(outcome.code, "EXECUTOR_EMPTY_DIFF");
        assert.match(outcome.message, /empty diff/);
      }
      assert.equal(runs, 2, "the spawn ran twice — one retry before parking");
      // The task is left resumable (in_progress), not silently completed.
      const state = await readState(dir);
      assert.equal(state.status, "in_progress");
    } finally {
      cleanup(dir);
    }
  });

  // OPT-IN: real Claude Code on the subscription. Needs a signed-in `claude`
  // and bills usage, so it is skipped unless explicitly enabled.
  it(
    "drives one real `claude -p` spawn in a worktree",
    { skip: process.env["LOOM_E2E_CLAUDE"] !== "1" },
    async () => {
      const dir = await freshGitProject();
      try {
        const executor = createClaudeCodeExecutor({ project_dir: dir });
        const outcome = await drive(dir, {
          executor,
          resolveRegistry: () => fixtureRegistry(),
          task: "create a file hello.txt containing the single word hi",
          client_idempotency_uuid: "cidem-real-claude",
        });
        assert.equal(outcome.kind, "complete");
      } finally {
        cleanup(dir);
      }
    },
  );
});
