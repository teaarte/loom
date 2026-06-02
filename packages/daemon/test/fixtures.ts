// Shared test fixtures for the daemon suite — a stub-provider fixture
// registry (spawn flow / gate flow / overflow flow), a temp SQLite project
// (with and without git), and stub executors. Mirrors the driver suite's
// harness so the supervisor is exercised over a REAL store + REAL git, with
// the backend stubbed (no `claude -p`, no mocked DB).

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Executor } from "@loomfsm/driver";
import { worktreePathFor } from "@loomfsm/driver";
import {
  buildVocabularies,
  closeDb,
  openDb,
  reconcileExtensions,
  type Agent,
  type Bundle,
  type DiscoveredManifest,
  type GateRole,
  type LLMProvider,
  type Policy,
  type PolicyName,
  type ProviderShuttleIntent,
  type Registry,
  type Stage,
  type UserAnswerSchema,
} from "@loomfsm/kernel";

export const FIXED_NOW = "2026-06-02T10:00:00.000Z";

export const GATE_SCHEMA: UserAnswerSchema = {
  options: [
    { verbs: ["approve", "yes"], label: "Approve", produces: { decision: "accept" } },
    {
      verbs: ["reject", "no"],
      label: "Reject",
      produces: { decision: "reject", reject_intent: "revise" },
    },
  ],
};

export function git(cwd: string, ...args: string[]): void {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
}

export function bundleManifest(name: string): DiscoveredManifest {
  return {
    path: `/fixture/bundle/${name}`,
    raw: {
      manifest_version: "1.0",
      name,
      display_name: name,
      description: "fixture bundle",
      version: "1.0.0",
      kind: "bundle",
      publisher: "@loom",
      capabilities: [],
      requires: { kernel_api: "^3.0.0" },
    },
  };
}

function stubProvider(): LLMProvider {
  return {
    name: "stub",
    capabilities: { execution: "shuttle", idempotent_spawn: true, reports_usage: false },
    async spawn() {
      throw new Error("the injected executor runs spawns, not the provider");
    },
  };
}

function assembleFixtureRegistry(
  bundle: Bundle,
  agents: Agent[],
  stages: Record<string, Stage>,
  flow: string[],
): Registry {
  const provider = stubProvider();
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

function bundleOf(stages: Record<string, Stage>, agents: Agent[], flow: string[]): Bundle {
  return {
    name: "code-fixture",
    version: "1.0.0",
    description: "daemon test fixture bundle",
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
}

// spawn-1 -> spawn-2 -> finalize : drives to a terminal complete.
export function spawnRegistry(): Registry {
  const stages: Record<string, Stage> = {
    "spawn-1": { kind: "spawn", name: "spawn-1", phase: "work", agent: "impl-1" },
    "spawn-2": { kind: "spawn", name: "spawn-2", phase: "work", agent: "impl-2" },
    "finalize-1": { kind: "finalize", name: "finalize-1" },
  };
  const agents: Agent[] = [
    { name: "impl-1", template_path: "templates/impl-1.md", output_kind: "nonreview" },
    { name: "impl-2", template_path: "templates/impl-2.md", output_kind: "nonreview" },
  ];
  const flow = ["spawn-1", "spawn-2", "finalize-1"];
  return assembleFixtureRegistry(bundleOf(stages, agents, flow), agents, stages, flow);
}

// spawn-1 -> finalize : a single spawn then terminal (used for the git
// merge-back path, where one worktree write is enough).
export function singleSpawnRegistry(): Registry {
  const stages: Record<string, Stage> = {
    "spawn-1": { kind: "spawn", name: "spawn-1", phase: "work", agent: "impl-1" },
    "finalize-1": { kind: "finalize", name: "finalize-1" },
  };
  const agents: Agent[] = [
    { name: "impl-1", template_path: "templates/impl-1.md", output_kind: "nonreview" },
  ];
  const flow = ["spawn-1", "finalize-1"];
  return assembleFixtureRegistry(bundleOf(stages, agents, flow), agents, stages, flow);
}

// gate-1 (human) -> finalize : parks at an ask-user.
export function gateRegistry(): Registry {
  const stages: Record<string, Stage> = {
    "gate-1": {
      kind: "gate",
      name: "gate-1",
      phase: "work",
      message: () => "Approve the plan?",
      valid_answers: () => GATE_SCHEMA,
    },
    "finalize-1": { kind: "finalize", name: "finalize-1" },
  };
  const flow = ["gate-1", "finalize-1"];
  return assembleFixtureRegistry(bundleOf(stages, [], flow), [], stages, flow);
}

export async function freshProject(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "loom-daemon-"));
  openDb(dir);
  await reconcileExtensions({
    manifests: [bundleManifest("code-fixture")],
    project_dir: dir,
    now: FIXED_NOW as never,
  });
  return dir;
}

// A temp project that is BOTH a SQLite store and a git repo with one commit.
export async function freshGitProject(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "loom-daemon-wt-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@loom.local");
  git(dir, "config", "user.name", "loom test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "seed.ts"), "export const seed = 1;\n", "utf8");
  git(dir, "add", "seed.ts");
  git(dir, "commit", "-q", "-m", "seed");
  openDb(dir);
  await reconcileExtensions({
    manifests: [bundleManifest("code-fixture")],
    project_dir: dir,
    now: FIXED_NOW as never,
  });
  return dir;
}

export function cleanup(dir: string): void {
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

// An executor that echoes a fixed output and records the agent_run_ids it saw.
export function recordingExecutor(seen: string[]): Executor {
  return {
    execute: async (s: ProviderShuttleIntent) => {
      seen.push(s.agent_run_id);
      return { agent_output: `done ${s.agent}` };
    },
  };
}
