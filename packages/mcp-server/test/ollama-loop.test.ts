// Opt-in: drive the whole loop with a REAL local model instead of the
// shuttle stub. Same kernel + transport path as the e2e test, but the
// test plays the host/runner and executes each spawn through the Ollama
// provider — real inference on the real `.md` prompts, real model output
// fed back through `pipeline_continue_task`, real gates, real finalize.
//
// Architecture note: the shuttle provider delegates agent execution to
// the host (in production that host is the agent CLI). There is no
// in-process executor in the kernel, so this test stands in as that host
// and uses Ollama to run each spawn. The kernel renders the agent's
// template body; injecting the task / refs / stack as a "## Spawn
// context" section is the host's job (the templates expect it), so the
// runner appends it here — the same thing a real host does.
//
// Skips cleanly unless a local Ollama is reachable and the model is
// pulled, so it never breaks CI. Run it explicitly:
//
//   LOOM_OLLAMA_MODEL=llama3.2 pnpm --filter @loomfsm/mcp-server test
//   LOOM_OLLAMA_MODEL=qwen2.5-coder:32b OLLAMA_HOST=http://localhost:11434 \
//     node --experimental-sqlite --test dist/test/ollama-loop.test.js

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { closeDb, type ContinueTaskInput, type ProviderSpawnRequest } from "@loomfsm/kernel";
import { claudeCodeShuttleProvider } from "@loomfsm/provider-claude-code-shuttle";
import { ollamaProvider } from "@loomfsm/provider-ollama";
import type { TransportResponse } from "@loomfsm/transport-types";

import {
  _resetRegistryCacheForTest,
  assembleRegistry,
  createAssembleRegistry,
} from "../src/bootstrap.js";
import {
  createContinueTaskTool,
  createGetSpawnPromptTool,
  createRunTaskTool,
} from "../src/index.js";

// Opt-in by an explicit model env var — empty means "skip", so a normal
// `pnpm test` never fires real inference even on a machine with Ollama up.
const MODEL = process.env["LOOM_OLLAMA_MODEL"] ?? "";
const HOST = process.env["OLLAMA_HOST"] ?? "http://localhost:11434";
const MAX_TOKENS = Number(process.env["LOOM_OLLAMA_MAX_TOKENS"] ?? "384");
const TASK = "fix the typo in the module header comment";

async function ollamaAvailable(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(`${HOST}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { ok: false, reason: `GET ${HOST}/api/tags -> ${res.status}` };
    const data = (await res.json()) as { models?: { name: string }[] };
    const names = (data.models ?? []).map((m) => m.name);
    const present = names.some(
      (n) => n === MODEL || n === `${MODEL}:latest` || n.startsWith(`${MODEL}:`),
    );
    if (!present) {
      return { ok: false, reason: `model '${MODEL}' not pulled (have: ${names.join(", ") || "none"})` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Ollama unreachable at ${HOST}: ${(err as Error).message}` };
  }
}

// Host-supplied spawn context. The kernel's prompt is the template body;
// a real host appends the task (and would add refs / stack / CLAUDE.md).
function withSpawnContext(templatePrompt: string): string {
  return `${templatePrompt}\n\n## Spawn context\n\nTask description: ${TASK}\n`;
}

async function runViaOllama(agent: string, agentRunId: string, prompt: string): Promise<string> {
  const req: ProviderSpawnRequest = {
    agent,
    agent_run_id: agentRunId,
    phase: "context",
    model: MODEL,
    prompt: withSpawnContext(prompt),
    extras: { max_tokens: MAX_TOKENS },
  };
  const result = await ollamaProvider.spawn(req);
  if (result.type !== "result") throw new Error(`expected a result envelope, got '${result.type}'`);
  return result.output;
}

describe("ollama loop (opt-in: requires a local Ollama + model)", () => {
  it(
    "drives classify → gates → fanout → finalize to complete on a real model",
    { timeout: 900_000 },
    async (t) => {
      if (MODEL === "") {
        t.skip("opt-in — set LOOM_OLLAMA_MODEL=<model> (e.g. llama3.2) to run on a local model");
        return;
      }
      const avail = await ollamaAvailable();
      if (!avail.ok) {
        t.skip(`${avail.reason} — set OLLAMA_HOST / LOOM_OLLAMA_MODEL and pull the model to run`);
        return;
      }

      _resetRegistryCacheForTest();
      const dir = mkdtempSync(join(tmpdir(), "loom-ollama-"));
      const allowlistPath = join(dir, "projects.allow");
      writeFileSync(allowlistPath, `${realpathSync(dir)}\n`, "utf8");
      const deps = { resolveRegistry: assembleRegistry, allowlistPath };
      const run = createRunTaskTool(deps);
      const cont = createContinueTaskTool(deps);
      const getPrompt = createGetSpawnPromptTool(deps);

      try {
        const first = await run({ project_dir: dir, task: TASK, client_idempotency_uuid: "ollama-1" });
        const dsid = first.driver_state_id ?? "";
        let resp: TransportResponse = first.response;
        const trace: string[] = [];
        let modelCalls = 0;
        let classifierSample = "";

        for (let i = 0; i < 80; i++) {
          if (resp.status === "complete") {
            trace.push(`complete:${resp.verdict}`);
            break;
          }
          if (resp.status === "error") {
            assert.fail(`loop hit error: ${resp.code} — ${resp.message}`);
          }

          let input: ContinueTaskInput;
          if (resp.status === "spawn-agent") {
            trace.push(`spawn:${resp.agent}`);
            const out = await runViaOllama(resp.agent, resp.agent_run_id, resp.spawn_request.prompt ?? "");
            modelCalls += 1;
            if (resp.agent === "classifier") classifierSample = out.slice(0, 300);
            input = { type: "agent-result", agent_run_id: resp.agent_run_id, agent_output: out };
          } else if (resp.status === "spawn-agents-parallel") {
            trace.push(`parallel:[${resp.spawns.map((s) => s.agent).join(",")}]`);
            const results: { agent_run_id: string; agent_output: string }[] = [];
            for (const s of resp.spawns) {
              const fetched = await getPrompt({ project_dir: dir, driver_state_id: dsid, agent_run_id: s.agent_run_id });
              const out = await runViaOllama(s.agent, s.agent_run_id, s.spawn_request.prompt ?? fetched.prompt ?? "");
              modelCalls += 1;
              results.push({ agent_run_id: s.agent_run_id, agent_output: out });
            }
            input = { type: "agents-results", results };
          } else if (resp.status === "ask-user") {
            trace.push(`gate:${resp.gate}`);
            input = { type: "user-answer", gate_event_id: resp.gate_event_id, decision: "accept" };
          } else {
            throw new Error(`unexpected status '${(resp as { status: string }).status}'`);
          }

          const next = await cont({ project_dir: dir, driver_state_id: dsid, input });
          resp = next.response;
        }

        console.log(`\n[ollama:${MODEL}] model calls=${modelCalls}`);
        console.log(`trace: ${trace.join(" -> ")}`);
        console.log(`classifier output (first 300 chars):\n${classifierSample}\n`);

        assert.equal(resp.status, "complete", `expected complete; trace=${trace.join(" -> ")}`);
        if (resp.status === "complete") {
          assert.equal(resp.verdict, "accepted");
        }
      } finally {
        try {
          closeDb(dir);
        } catch {
          /* ignore */
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "routes ONLY the classifier to ollama via .claude/providers.json; the rest use the shuttle",
    { timeout: 900_000 },
    async (t) => {
      if (MODEL === "") {
        t.skip("opt-in — set LOOM_OLLAMA_MODEL=<model> to run on a local model");
        return;
      }
      const avail = await ollamaAvailable();
      if (!avail.ok) {
        t.skip(`${avail.reason} — set OLLAMA_HOST / LOOM_OLLAMA_MODEL and pull the model to run`);
        return;
      }

      _resetRegistryCacheForTest();
      const dir = mkdtempSync(join(tmpdir(), "loom-ollama-route-"));
      const allowlistPath = join(dir, "projects.allow");
      writeFileSync(allowlistPath, `${realpathSync(dir)}\n`, "utf8");

      // Project routing: classifier → ollama (real model), everything else
      // → the shuttle default (the host echoes those). The provider SET is
      // the deployment's choice (injected below); the per-agent mapping is
      // this project's `.claude/providers.json`.
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(
        join(dir, ".claude", "providers.json"),
        JSON.stringify({
          agent_routing: { classifier: { provider: "ollama", tier: "local" } },
          tier_aliases: { local: { model: MODEL } },
          default_provider: "claude-code-shuttle",
        }),
        "utf8",
      );

      const resolveRegistry = createAssembleRegistry([
        claudeCodeShuttleProvider,
        ollamaProvider,
      ]);
      const deps = { resolveRegistry, allowlistPath };
      const run = createRunTaskTool(deps);
      const cont = createContinueTaskTool(deps);

      const CANON = JSON.stringify({ verdict: "pass", findings: [] });
      try {
        const first = await run({
          project_dir: dir,
          task: TASK,
          client_idempotency_uuid: "ollama-route-1",
        });
        const dsid = first.driver_state_id ?? "";
        let resp: TransportResponse = first.response;
        const trace: string[] = [];
        let classifierProvider = "";
        let classifierModel = "";
        let classifierSample = "";

        for (let i = 0; i < 80; i++) {
          if (resp.status === "complete") {
            trace.push(`complete:${resp.verdict}`);
            break;
          }
          if (resp.status === "error") {
            assert.fail(`loop hit error: ${resp.code} — ${resp.message}`);
          }

          let input: ContinueTaskInput;
          if (resp.status === "spawn-agent") {
            const sr = resp.spawn_request;
            const provider = (sr.extras?.["provider"] as string | undefined) ?? "";
            trace.push(`spawn:${resp.agent}@${provider}`);
            let out: string;
            if (provider === "ollama") {
              // Run the ROUTED model on the raw kernel prompt (A2 supplies
              // the spawn context; no host-side injection).
              const r = await ollamaProvider.spawn({
                agent: resp.agent,
                agent_run_id: resp.agent_run_id,
                phase: "context",
                model: sr.model ?? MODEL,
                prompt: sr.prompt ?? "",
                extras: { max_tokens: MAX_TOKENS },
              });
              if (r.type !== "result") throw new Error(`expected a result, got '${r.type}'`);
              out = r.output;
              if (resp.agent === "classifier") {
                classifierProvider = provider;
                classifierModel = sr.model ?? "";
                classifierSample = out.slice(0, 300);
              }
            } else {
              out = CANON; // shuttle-routed agents are echoed by the host
            }
            input = { type: "agent-result", agent_run_id: resp.agent_run_id, agent_output: out };
          } else if (resp.status === "spawn-agents-parallel") {
            trace.push(`parallel:[${resp.spawns.map((s) => s.agent).join(",")}]`);
            input = {
              type: "agents-results",
              results: resp.spawns.map((s) => ({
                agent_run_id: s.agent_run_id,
                agent_output: CANON,
              })),
            };
          } else if (resp.status === "ask-user") {
            trace.push(`gate:${resp.gate}`);
            input = { type: "user-answer", gate_event_id: resp.gate_event_id, decision: "accept" };
          } else {
            throw new Error(`unexpected status '${(resp as { status: string }).status}'`);
          }

          const next = await cont({ project_dir: dir, driver_state_id: dsid, input });
          resp = next.response;
        }

        console.log(`\n[ollama-route:${MODEL}] classifier provider=${classifierProvider} model=${classifierModel}`);
        console.log(`trace: ${trace.join(" -> ")}`);
        console.log(`classifier output (first 300 chars):\n${classifierSample}\n`);

        // The classifier was routed to ollama with the configured model; the
        // flow still completed (other agents used the shuttle echo).
        assert.equal(classifierProvider, "ollama", "classifier should route to ollama");
        assert.equal(classifierModel, MODEL, "classifier directive should carry the routed model");
        assert.ok(classifierSample.length > 0, "classifier produced real model output");
        assert.equal(resp.status, "complete", `expected complete; trace=${trace.join(" -> ")}`);
        if (resp.status === "complete") assert.equal(resp.verdict, "accepted");
      } finally {
        try {
          closeDb(dir);
        } catch {
          /* ignore */
        }
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
