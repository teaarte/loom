// End-to-end wire smoke. Two layers, both driving REAL JSON-RPC framing
// (never the handler bodies directly — those are covered elsewhere):
//
//   (a) functional — an SDK Client connected to createServer(deps).server
//       over an in-process linked transport pair. Lists the tools (expect
//       twelve) and calls the read-only + lifecycle ones, asserting the
//       decoded result shape (the cross-owner marker tool is exercised in
//       recover.test.ts). A test registry is injected so the active-task
//       tools have a flow to tick.
//   (b) boot — spawns the actual stdio binary as a child process and
//       exchanges framed requests over its real stdio pipes, proving the
//       entrypoint boots and frames tools/list + a read-only call.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

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
  type Registry,
  type Stage,
} from "@loomfsm/kernel";

import { createServer } from "../src/index.js";

const FIXED_NOW = "2026-05-28T10:00:00.000Z";

function bundleManifest(name: string): DiscoveredManifest {
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

// Two spawn stages so delivering the first agent's result advances the
// FSM to a second spawn directive — enough to exercise continue + recover.
function buildRegistry(): Registry {
  const stages: Record<string, Stage> = {
    "spawn-1": { kind: "spawn", name: "spawn-1", phase: "work", agent: "impl-1" },
    "spawn-2": { kind: "spawn", name: "spawn-2", phase: "work", agent: "impl-2" },
  };
  const agents: Agent[] = [
    { name: "impl-1", template_path: "templates/impl-1.md", output_kind: "nonreview" },
    { name: "impl-2", template_path: "templates/impl-2.md", output_kind: "nonreview" },
  ];
  const bundle: Bundle = {
    name: "code-fixture",
    version: "1.0.0",
    description: "wire smoke fixture bundle",
    phases: ["work"],
    default_flow: "standard",
    default_gate_policies: {} as Record<GateRole, PolicyName>,
    gate_roles: {},
    agents,
    stages,
    flows: { standard: ["spawn-1", "spawn-2"] },
    hooks: [],
    invariants: [],
  };
  const provider: LLMProvider = {
    name: "stub",
    capabilities: { execution: "shuttle", idempotent_spawn: true, reports_usage: false },
    async spawn() {
      throw new Error("stub provider spawn must not be called from the wire smoke");
    },
  };
  const policyFactories = new Map<PolicyName, () => Policy>();
  policyFactories.set("human", () => () => ({ type: "human-required", reason: "test" }));
  return {
    bundle,
    agents: new Map(agents.map((a) => [a.name, a])),
    stages: new Map(Object.entries(stages)),
    flows: new Map([["standard", ["spawn-1", "spawn-2"]]]),
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

// Decode the JSON the server packs into the single text content block.
interface TextContent {
  type: string;
  text: string;
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as TextContent[];
  assert.ok(Array.isArray(content) && content.length > 0, `${name} returned no content`);
  const first = content[0];
  assert.ok(first !== undefined && typeof first.text === "string", `${name} content not text`);
  return JSON.parse(first.text) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object", "expected an object");
  return value as Record<string, unknown>;
}

// A connected client + server over an in-process linked pair, against a
// fresh migrated `src` project and an empty `tgt` restore target (both
// allowlisted). Each test gets its own harness so a failure in one tool
// never masks another and the active-task tools never cross-contaminate
// state (the state DB holds exactly one task per project).
interface Wire {
  client: Client;
  src: string;
  tgt: string;
  dispose: () => Promise<void>;
}

async function freshWire(): Promise<Wire> {
  const src = mkdtempSync(join(tmpdir(), "loom-wire-src-"));
  const tgt = mkdtempSync(join(tmpdir(), "loom-wire-tgt-"));
  openDb(src);
  openDb(tgt);
  await reconcileExtensions({
    manifests: [bundleManifest("code-fixture")],
    project_dir: src,
    now: FIXED_NOW as never,
  });
  const allowlistPath = join(src, "projects.allow");
  writeFileSync(allowlistPath, `${realpathSync(src)}\n${realpathSync(tgt)}\n`, "utf8");

  const handle = createServer({ resolveRegistry: () => buildRegistry(), allowlistPath });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "wire-smoke-client", version: "0.0.0" });
  await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);

  const dispose = async (): Promise<void> => {
    await client.close().catch(() => {});
    await handle.server.close().catch(() => {});
    for (const dir of [src, tgt]) {
      try {
        closeDb(dir);
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return { client, src, tgt, dispose };
}

// Start a task and return its identifiers — the entry every active-task
// tool needs. Asserts the first directive is a spawn-agent so a failure
// here is unambiguous.
async function startTask(
  client: Client,
  src: string,
  uuid: string,
): Promise<{ driverStateId: string; agentRunId: string }> {
  const run = asRecord(
    await call(client, "pipeline_run_task", {
      project_dir: src,
      task: "drive the wire",
      client_idempotency_uuid: uuid,
    }),
  );
  const response = asRecord(run["response"]);
  assert.equal(response["status"], "spawn-agent");
  const driverStateId = run["driver_state_id"] as string;
  const agentRunId = response["agent_run_id"] as string;
  assert.ok(driverStateId && agentRunId, "run_task must surface driver + agent ids");
  return { driverStateId, agentRunId };
}

describe("wire smoke — functional (in-memory linked transport)", () => {
  it("tools/list returns exactly the twelve registered tools", async () => {
    const w = await freshWire();
    try {
      const listed = await w.client.listTools();
      const names = listed.tools.map((t) => t.name).sort();
      assert.deepEqual(names, [
        "pipeline_archive_and_reset",
        "pipeline_backup",
        "pipeline_continue_task",
        "pipeline_extensions_list",
        "pipeline_get_spawn_prompt",
        "pipeline_issue_cross_owner_marker",
        "pipeline_meta",
        "pipeline_recover",
        "pipeline_restore",
        "pipeline_resume",
        "pipeline_run_task",
        "pipeline_state_get",
      ]);
      // Every descriptor must carry an object input schema, or a client
      // cannot construct a valid call.
      for (const t of listed.tools) {
        assert.equal((t.inputSchema as { type?: string }).type, "object");
      }
    } finally {
      await w.dispose();
    }
  });

  it("pipeline_meta echoes the protocol version", async () => {
    const w = await freshWire();
    try {
      const meta = asRecord(await call(w.client, "pipeline_meta", { project_dir: w.src }));
      assert.equal(meta["protocol_version"], "3.0.0");
    } finally {
      await w.dispose();
    }
  });

  it("pipeline_extensions_list returns the reconciled bundle", async () => {
    const w = await freshWire();
    try {
      const ext = asRecord(
        await call(w.client, "pipeline_extensions_list", { project_dir: w.src }),
      );
      const extensions = ext["extensions"];
      assert.ok(Array.isArray(extensions));
      assert.ok(
        extensions.some((e) => asRecord(e)["name"] === "code-fixture"),
        "the reconciled bundle should appear in the extensions list",
      );
    } finally {
      await w.dispose();
    }
  });

  it("pipeline_run_task shapes the first directive as a spawn-agent", async () => {
    const w = await freshWire();
    try {
      await startTask(w.client, w.src, "uuid-wire-run");
    } finally {
      await w.dispose();
    }
  });

  it("pipeline_state_get summary reflects the live task", async () => {
    const w = await freshWire();
    try {
      await startTask(w.client, w.src, "uuid-wire-state");
      const state = asRecord(
        await call(w.client, "pipeline_state_get", { project_dir: w.src, format: "summary" }),
      );
      assert.equal(state["format"], "summary");
      assert.equal(asRecord(state["summary"])["status"], "in_progress");
    } finally {
      await w.dispose();
    }
  });

  it("pipeline_continue_task advances the FSM to the second spawn", async () => {
    const w = await freshWire();
    try {
      const { driverStateId, agentRunId } = await startTask(w.client, w.src, "uuid-wire-cont");
      const cont = asRecord(
        await call(w.client, "pipeline_continue_task", {
          project_dir: w.src,
          driver_state_id: driverStateId,
          input: { type: "agent-result", agent_run_id: agentRunId, agent_output: "first done" },
        }),
      );
      const response = asRecord(cont["response"]);
      assert.equal(response["status"], "spawn-agent");
      assert.equal(response["agent"], "impl-2");
    } finally {
      await w.dispose();
    }
  });

  it("pipeline_recover abandon shapes a terminal envelope + recovery_id", async () => {
    const w = await freshWire();
    try {
      const { driverStateId } = await startTask(w.client, w.src, "uuid-wire-rec");
      const recover = asRecord(
        await call(w.client, "pipeline_recover", {
          project_dir: w.src,
          driver_state_id: driverStateId,
          choice: "abandon",
        }),
      );
      assert.match(recover["recovery_id"] as string, /^rec-/);
      assert.equal(asRecord(recover["response"])["status"], "complete");
    } finally {
      await w.dispose();
    }
  });

  it("pipeline_backup writes a non-empty dump and reports bytes_written", async () => {
    const w = await freshWire();
    try {
      await startTask(w.client, w.src, "uuid-wire-bk");
      const backup = asRecord(
        await call(w.client, "pipeline_backup", { project_dir: w.src, to: "state.sql" }),
      );
      assert.ok((backup["bytes_written"] as number) > 0);
      assert.ok(typeof backup["backup_path"] === "string" && backup["backup_path"].length > 0);
    } finally {
      await w.dispose();
    }
  });

  it("pipeline_restore replays the dump into the target and reproduces the task over the wire", async () => {
    const w = await freshWire();
    try {
      await startTask(w.client, w.src, "uuid-wire-restore");
      const backup = asRecord(
        await call(w.client, "pipeline_backup", { project_dir: w.src, to: "state.sql" }),
      );
      const backupPath = backup["backup_path"] as string;

      const restore = asRecord(
        await call(w.client, "pipeline_restore", {
          project_dir: w.tgt,
          from: backupPath,
          format: "sql",
          confirm: true,
        }),
      );
      assert.equal(restore["restored"], true);

      // Prove the restore actually reproduced state — verified entirely
      // over JSON-RPC, not by a direct DB read: the fresh target now
      // reports the source task as in_progress.
      const tgtState = asRecord(
        await call(w.client, "pipeline_state_get", { project_dir: w.tgt, format: "summary" }),
      );
      assert.equal(asRecord(tgtState["summary"])["status"], "in_progress");
    } finally {
      await w.dispose();
    }
  });
});

describe("wire smoke — boot (child-process stdio binary)", () => {
  it("the stdio binary boots, frames tools/list + a read-only call, and drives an active-task call through the wired registry to a real spawn", async () => {
    // dist/test/wire-smoke.test.js → ../src/bin/stdio.js
    const here = dirname(fileURLToPath(import.meta.url));
    const binPath = join(here, "..", "src", "bin", "stdio.js");
    const projectDir = mkdtempSync(join(tmpdir(), "loom-wire-boot-"));

    // The binary resolves the allowlist at $HOME/.loom/projects.allow.
    // Point HOME at a temp dir that allowlists the project, so the
    // active-task call clears the allowlist gate and reaches the wired
    // registry — proving the binary assembles the installed bundle and
    // returns a real first directive over its actual stdio pipes.
    const fakeHome = mkdtempSync(join(tmpdir(), "loom-wire-home-"));
    mkdirSync(join(fakeHome, ".loom"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".loom", "projects.allow"),
      `${realpathSync(projectDir)}\n`,
      "utf8",
    );

    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) childEnv[k] = v;
    }
    childEnv["HOME"] = fakeHome;

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--experimental-sqlite", "--no-warnings", binPath],
      env: childEnv,
    });
    const client = new Client({ name: "wire-smoke-boot-client", version: "0.0.0" });

    try {
      await client.connect(transport);

      const listed = await client.listTools();
      assert.equal(listed.tools.length, 12);

      // A read-only call frames correctly over real stdio pipes.
      const meta = asRecord(await call(client, "pipeline_meta", { project_dir: projectDir }));
      assert.equal(meta["protocol_version"], "3.0.0");

      // An active-task call over the binary now reaches the wired
      // registry: the installed bundle is assembled and the FSM ticks to
      // its first directive — a real spawn-agent envelope, framed over the
      // actual stdio pipes, not a crash or a refusal.
      const run = asRecord(
        await call(client, "pipeline_run_task", {
          project_dir: projectDir,
          task: "fix a typo in the README",
          client_idempotency_uuid: "uuid-boot-1",
        }),
      );
      const runResponse = asRecord(run["response"]);
      assert.equal(runResponse["status"], "spawn-agent");
      assert.equal(runResponse["agent"], "classifier");
      const spawnRequest = asRecord(runResponse["spawn_request"]);
      assert.ok(
        typeof spawnRequest["prompt"] === "string" &&
          spawnRequest["prompt"].includes("# Classifier agent"),
        "the spawn prompt should carry the real classifier template body",
      );
    } finally {
      await client.close().catch(() => {});
      try {
        closeDb(projectDir);
      } catch {
        /* ignore */
      }
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
