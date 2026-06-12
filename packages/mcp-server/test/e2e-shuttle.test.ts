// End-to-end shuttle loop, fully in-process and deterministic.
//
// Exercises the production wiring (`assembleRegistry` → reconcile the
// installed bundle + load it with the zero-config shuttle provider) and
// drives a complete task through the real FSM — classify, gate, plan,
// gate, implement, multi-reviewer fanout, final gate, finalize — to
// `complete`. No host, no API key, no network: an in-process echo
// executor stands in for the host's task-runner. Every spawn directive
// is answered with one canonical agent payload and fed back through
// `pipeline_continue_task`; every gate is approved through the same
// surface. The state DB is a real temp SQLite file.
//
// This is the deterministic counterpart to a manual run against a host:
// it proves the spawn → deliver → next-directive → gate → finalize cycle
// holds across the full flow without anyone driving it by hand.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { closeDb, openDb } from "@loomfsm/kernel";
import type { TransportResponse } from "@loomfsm/transport-types";

import { _resetRegistryCacheForTest, assembleRegistry } from "../src/bootstrap.js";
import {
  createContinueTaskTool,
  createGetSpawnPromptTool,
  createRunTaskTool,
} from "../src/index.js";

// One payload that satisfies every kernel output kind: a parseable JSON
// header carrying a verdict + an empty findings array. Reviewers and
// validators read the verdict/findings; the classifier reads it as a
// (benign) header; nonreview ignores it. No findings → no blockers, so
// the on-blockers-capable gates stay clean and the run is accept-clean.
const CANONICAL_AGENT_OUTPUT = JSON.stringify({ verdict: "pass", findings: [] });

interface Harness {
  dir: string;
  allowlistPath: string;
  dispose: () => void;
}

function freshHarness(label: string): Harness {
  const dir = mkdtempSync(join(tmpdir(), `loom-e2e-${label}-`));
  const allowlistPath = join(dir, "projects.allow");
  writeFileSync(allowlistPath, `${realpathSync(dir)}\n`, "utf8");
  const dispose = (): void => {
    try {
      closeDb(dir);
    } catch {
      /* may already be closed */
    }
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, allowlistPath, dispose };
}

function gitRun(dir: string, ...args: string[]): void {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
  }
}

function commitFile(dir: string, rel: string, body: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
  gitRun(dir, "add", "-A");
  gitRun(dir, "commit", "-q", "-m", `add ${rel}`);
}

// A harness whose project dir is a real git repo with a baseline commit
// already in place — so run_task captures the baseline and a later commit
// is visible to the server-computed delta. State DB + allowlist are
// gitignored so they never count as task output.
function freshGitHarness(label: string): Harness {
  const h = freshHarness(label);
  gitRun(h.dir, "init", "-q");
  gitRun(h.dir, "config", "user.email", "test@loom.test");
  gitRun(h.dir, "config", "user.name", "loom test");
  gitRun(h.dir, "checkout", "-q", "-b", "main");
  writeFileSync(join(h.dir, ".gitignore"), ".loom/\nprojects.allow\n", "utf8");
  gitRun(h.dir, "add", "-A");
  gitRun(h.dir, "commit", "-q", "-m", "baseline");
  return h;
}

interface DriveResult {
  trace: string[];
  verdict: string | null;
  spawnPrompts: { agent: string; prompt: string }[];
}

// Drive a fresh task to its terminal directive with the echo executor.
// Returns the directive trace, the final verdict, and every prompt the
// host would have run (so a caller can assert real template bodies).
async function driveToComplete(
  h: Harness,
  task: string,
  policyPreset?: string,
): Promise<DriveResult> {
  const deps = { resolveRegistry: assembleRegistry, allowlistPath: h.allowlistPath };
  const run = createRunTaskTool(deps);
  const cont = createContinueTaskTool(deps);
  const getPrompt = createGetSpawnPromptTool(deps);

  const trace: string[] = [];
  const spawnPrompts: { agent: string; prompt: string }[] = [];
  const resolvePrompts = (resp: TransportResponse, driverStateId: string): Promise<void> =>
    recordSpawnPrompts(resp, spawnPrompts, getPrompt, h.dir, driverStateId);

  const first = await run({
    project_dir: h.dir,
    task,
    client_idempotency_uuid: `e2e-${task}`,
    ...(policyPreset !== undefined ? { policy_preset: policyPreset } : {}),
  });
  const driverStateId = first.driver_state_id ?? "";
  let resp: TransportResponse = first.response;
  await resolvePrompts(resp, driverStateId);

  // Generous cap: the medium flow settles in well under this; the cap is
  // only a runaway guard so a regression fails fast instead of hanging.
  for (let step = 0; step < 80; step++) {
    if (resp.status === "complete") {
      trace.push(`complete:${resp.verdict}`);
      return { trace, verdict: resp.verdict, spawnPrompts };
    }
    if (resp.status === "error") {
      trace.push(`error:${resp.code}`);
      assert.fail(`loop hit error directive: ${resp.code} — ${resp.message}`);
    }

    const input = echoInputFor(resp);
    trace.push(labelFor(resp));
    const next = await cont({ project_dir: h.dir, driver_state_id: driverStateId, input });
    resp = next.response;
    await resolvePrompts(resp, driverStateId);
  }
  assert.fail(`loop did not terminate within the step cap; trace=${trace.join(" -> ")}`);
}

function echoInputFor(resp: TransportResponse): Parameters<
  ReturnType<typeof createContinueTaskTool>
>[0]["input"] {
  switch (resp.status) {
    case "spawn-agent":
      return {
        type: "agent-result",
        agent_run_id: resp.agent_run_id,
        agent_output: CANONICAL_AGENT_OUTPUT,
      };
    case "spawn-agents-parallel":
      return {
        type: "agents-results",
        results: resp.spawns.map((s) => ({
          agent_run_id: s.agent_run_id,
          agent_output: CANONICAL_AGENT_OUTPUT,
        })),
      };
    case "ask-user":
      return { type: "user-answer", gate_event_id: resp.gate_event_id, decision: "accept" };
    default:
      throw new Error(`echo executor cannot answer status '${resp.status}'`);
  }
}

function labelFor(resp: TransportResponse): string {
  switch (resp.status) {
    case "spawn-agent":
      return `spawn:${resp.agent}`;
    case "spawn-agents-parallel":
      return `parallel:[${resp.spawns.map((s) => s.agent).join(",")}]`;
    case "ask-user":
      return `gate:${resp.gate}`;
    default:
      return resp.status;
  }
}

async function recordSpawnPrompts(
  resp: TransportResponse,
  into: { agent: string; prompt: string }[],
  getPrompt: ReturnType<typeof createGetSpawnPromptTool>,
  projectDir: string,
  driverStateId: string,
): Promise<void> {
  if (resp.status === "spawn-agent") {
    // Single spawns carry the prompt inline (no reference round trip).
    into.push({ agent: resp.agent, prompt: resp.spawn_request.prompt ?? "" });
  } else if (resp.status === "spawn-agents-parallel") {
    for (const s of resp.spawns) {
      // By-reference fanout: fetch each prompt the way the router does.
      const inline = s.spawn_request.prompt;
      if (inline !== undefined) {
        into.push({ agent: s.agent, prompt: inline });
        continue;
      }
      const fetched = await getPrompt({
        project_dir: projectDir,
        driver_state_id: driverStateId,
        agent_run_id: s.agent_run_id,
      });
      assert.equal(fetched.error, undefined, `prompt fetch for '${s.agent}' should not error`);
      into.push({ agent: s.agent, prompt: fetched.prompt ?? "" });
    }
  }
}

describe("e2e shuttle — no wiring", () => {
  it("the active-task surface refuses with REGISTRY_UNAVAILABLE when no resolver is wired", async () => {
    const h = freshHarness("noreg");
    try {
      // No resolveRegistry — the read-only surface is unaffected, but the
      // active-task path must answer with the structured refusal envelope.
      const run = createRunTaskTool({ allowlistPath: h.allowlistPath });
      const res = await run({
        project_dir: h.dir,
        task: "no registry wired",
        client_idempotency_uuid: "e2e-noreg-1",
      });
      assert.equal(res.response.status, "error");
      if (res.response.status === "error") {
        assert.equal(res.response.code, "REGISTRY_UNAVAILABLE");
      }
    } finally {
      h.dispose();
    }
  });
});

describe("e2e shuttle — wired registry", () => {
  it("the first directive's prompt is the real classifier template body, not a stub", async () => {
    _resetRegistryCacheForTest();
    const h = freshHarness("prompt");
    try {
      const run = createRunTaskTool({
        resolveRegistry: assembleRegistry,
        allowlistPath: h.allowlistPath,
      });
      const res = await run({
        project_dir: h.dir,
        task: "fix a typo in the README",
        client_idempotency_uuid: "e2e-prompt-1",
      });
      assert.equal(res.response.status, "spawn-agent");
      if (res.response.status === "spawn-agent") {
        assert.equal(res.response.agent, "classifier");
        const prompt = res.response.spawn_request.prompt ?? "";
        // A unique substring of agents/classifier.md — present only when
        // the loader read the template body off disk.
        assert.ok(
          prompt.includes("# Classifier agent"),
          "prompt should carry the classifier template body",
        );
        assert.ok(
          prompt.includes("You are a **classifier**"),
          "prompt should carry the classifier template body",
        );
        // NOT the deterministic stub (`agent=…\ntemplate=…`) the renderer
        // falls back to when no template was materialized.
        assert.ok(
          !prompt.startsWith("agent=classifier"),
          "prompt must not be the no-template stub",
        );
        // The wired path now carries the task: the renderer appends a
        // `## Spawn context` block with the verbatim task under it, so the
        // classifier classifies the ACTUAL task, not an all-defaults stub.
        assert.ok(
          prompt.includes("## Spawn context"),
          "prompt should carry the appended spawn-context block",
        );
        assert.ok(
          prompt.includes("### Canonical identifiers"),
          "spawn context should expose the canonical ids the classifier copies",
        );
        assert.ok(
          prompt.includes("fix a typo in the README"),
          "spawn context should carry the verbatim task description",
        );
        // The bundle's declared context assets are materialized and injected
        // into the classifier's prompt: the refs catalog (real filenames, the
        // field that hallucinated when absent) + the stack candidate registry.
        assert.ok(
          prompt.includes("### Refs catalog"),
          "classifier prompt should carry the materialized refs catalog",
        );
        assert.ok(
          prompt.includes("FILE: knowledge/references/"),
          "refs catalog should list real reference filenames",
        );
        assert.ok(
          prompt.includes("### Stack candidate registry"),
          "classifier prompt should carry the stack candidate registry",
        );
      }
    } finally {
      h.dispose();
    }
  });

  it("injects bundle context assets only into the classifier across the full wired flow", async () => {
    _resetRegistryCacheForTest();
    const h = freshHarness("assets");
    try {
      const result = await driveToComplete(h, "harden the auth layer against brute force");

      // The classifier carries the materialized refs catalog (real
      // filenames), the stack registry, and the active-agents roster.
      const classifier = result.spawnPrompts.find((s) => s.agent === "classifier");
      assert.ok(classifier !== undefined, "classifier should spawn");
      assert.ok(classifier.prompt.includes("### Refs catalog"));
      assert.ok(classifier.prompt.includes("FILE: knowledge/references/"));
      assert.ok(classifier.prompt.includes("### Stack candidate registry"));
      assert.ok(classifier.prompt.includes("### Active agents"));

      // Active agents lists the flow's real spawn/fanout targets.
      const activeLine =
        classifier.prompt.slice(classifier.prompt.indexOf("### Active agents")).split("\n")[1] ?? "";
      assert.ok(activeLine.includes("implementer"), `active agents should list implementer; got: ${activeLine}`);
      assert.ok(activeLine.includes("logic-reviewer"), `active agents should list logic-reviewer; got: ${activeLine}`);

      // Scoping holds end-to-end: no other agent's prompt carries the bulky
      // catalog / registry (it belongs only in the prompt that consumes it).
      for (const sp of result.spawnPrompts) {
        if (sp.agent === "classifier") continue;
        assert.ok(
          !sp.prompt.includes("### Refs catalog"),
          `agent '${sp.agent}' must not carry the refs catalog`,
        );
        assert.ok(
          !sp.prompt.includes("### Stack candidate registry"),
          `agent '${sp.agent}' must not carry the stack registry`,
        );
      }
    } finally {
      h.dispose();
    }
  });

  it("a normal-size fanout inlines its prompts — one round-trip, no by-reference fetch", async () => {
    // The common case after the inline threshold landed: a routine task's
    // fanout prompts sum under the cap, so every prompt rides the wire
    // inline. The host dispatches the batch and delivers one results
    // payload — no per-agent get_spawn_prompt call. Reverting the inline
    // branch (forcing always-by-reference) reddens this.
    _resetRegistryCacheForTest();
    const h = freshHarness("inline");
    try {
      const deps = { resolveRegistry: assembleRegistry, allowlistPath: h.allowlistPath };
      const run = createRunTaskTool(deps);
      const cont = createContinueTaskTool(deps);

      const first = await run({
        project_dir: h.dir,
        task: "harden the auth layer against brute force",
        client_idempotency_uuid: "e2e-inline-1",
      });
      const driverStateId = first.driver_state_id ?? "";
      let resp: TransportResponse = first.response;

      let fanoutCount = 0;
      for (let step = 0; step < 80 && resp.status !== "complete" && resp.status !== "error"; step++) {
        if (resp.status === "spawn-agents-parallel") {
          fanoutCount++;
          // No by-reference flag, every prompt present inline + a real body.
          assert.equal(
            resp.prompts_by_reference,
            undefined,
            "a sub-cap fanout must not flip to by-reference",
          );
          for (const s of resp.spawns) {
            assert.ok(
              (s.spawn_request.prompt ?? "").length > 200,
              `fanout spawn '${s.agent}' should inline its real prompt body`,
            );
            assert.ok(
              !(s.spawn_request.prompt ?? "").startsWith("agent="),
              `fanout spawn '${s.agent}' must carry a materialized prompt, not the stub`,
            );
          }
        }
        const next = await cont({
          project_dir: h.dir,
          driver_state_id: driverStateId,
          input: echoInputFor(resp),
        });
        resp = next.response;
      }
      assert.ok(fanoutCount >= 1, "expected at least one reviewer fanout");
    } finally {
      h.dispose();
    }
  });

  it("an over-cap fanout falls back to by-reference — response bounded, prompts fetchable", async () => {
    // A large task is embedded verbatim in every fanout prompt, so the
    // batch sums over the inline cap. The transport must keep the spill-safe
    // by-reference shape: prompts_by_reference: true, prompts omitted, the
    // envelope a small list of {agent_run_id, agent, model, extras} that
    // stays bounded regardless of fanout width, and the prompt re-derivable
    // through the read-only fetch. Reverting the threshold (always inline)
    // reddens this — the envelope would balloon and prompts_by_reference
    // would be absent.
    _resetRegistryCacheForTest();
    const h = freshHarness("byref");
    try {
      const deps = { resolveRegistry: assembleRegistry, allowlistPath: h.allowlistPath };
      const run = createRunTaskTool(deps);
      const cont = createContinueTaskTool(deps);
      const getPrompt = createGetSpawnPromptTool(deps);

      // ~20k chars of task text pushes each embedded prompt — and thus any
      // fanout — well over the inline cap.
      const first = await run({
        project_dir: h.dir,
        task: "harden the auth layer against brute force. " + "PADDING ".repeat(2500),
        client_idempotency_uuid: "e2e-byref-1",
      });
      const driverStateId = first.driver_state_id ?? "";
      let resp: TransportResponse = first.response;

      const fanouts: { count: number; bytes: number }[] = [];
      let widestFetchedBody = "";
      let widestCount = 0;

      for (let step = 0; step < 80 && resp.status !== "complete" && resp.status !== "error"; step++) {
        if (resp.status === "spawn-agents-parallel") {
          // Over the cap → by-reference: flag set, every prompt omitted.
          assert.equal(resp.prompts_by_reference, true, "over-cap fanout must set prompts_by_reference");
          for (const s of resp.spawns) {
            assert.equal(
              s.spawn_request.prompt,
              undefined,
              `over-cap fanout spawn '${s.agent}' must not inline its prompt`,
            );
          }
          fanouts.push({ count: resp.spawns.length, bytes: JSON.stringify(resp).length });
          if (resp.spawns.length > widestCount) {
            widestCount = resp.spawns.length;
            // Fetch WHILE the fanout is pending (the host fetches before
            // delivering — once delivered the pending row drains).
            const target = resp.spawns.find((s) => s.agent === "logic-reviewer") ?? resp.spawns[0]!;
            const fetched = await getPrompt({
              project_dir: h.dir,
              driver_state_id: driverStateId,
              agent_run_id: target.agent_run_id,
            });
            assert.equal(fetched.error, undefined, "by-reference prompt fetch should not error");
            widestFetchedBody = fetched.prompt ?? "";
          }
        }
        const next = await cont({
          project_dir: h.dir,
          driver_state_id: driverStateId,
          input: echoInputFor(resp),
        });
        resp = next.response;
      }

      // With prompts by reference the envelope is a list of
      // {agent_run_id, agent, model, extras} — a few hundred bytes per
      // agent, orders of magnitude under the ~84k an inlined wide fanout of
      // this task would produce. A fixed ceiling that holds however wide
      // the fanout grows.
      assert.ok(fanouts.length >= 1, "expected at least one reviewer fanout");
      const widest = fanouts.reduce((m, f) => (f.count > m.count ? f : m), fanouts[0]!);
      assert.ok(widest.count >= 2, `widest fanout should have ≥2 agents; got ${widest.count}`);
      assert.ok(
        widest.bytes < 4000,
        `by-reference fanout response must stay small; ${widest.count} agents → ${widest.bytes} bytes`,
      );

      // The reference resolves to the real materialized template body — and
      // it does embed the large task, which is exactly why it tripped the cap.
      assert.ok(widestFetchedBody.length > 200, "fetched prompt should be the real body");
      assert.ok(
        !widestFetchedBody.startsWith("agent="),
        "fetched prompt must not be the no-template stub",
      );
    } finally {
      h.dispose();
    }
  });

  it("drives classify → gates → fanout → finalize to complete, five runs in a row", async () => {
    for (let runIndex = 0; runIndex < 5; runIndex++) {
      _resetRegistryCacheForTest();
      const h = freshHarness(`loop${runIndex}`);
      try {
        // Drive under full-supervised so all three gates surface as
        // ask-user and the gate-traversal assertions below can observe
        // them. Under the no-flag default (bundle on-blockers) a clean run
        // auto-resolves the gates — that path is asserted separately.
        const result = await driveToComplete(h, `fix-${runIndex}`, "full-supervised");

        // Reached natural completion with the clean-run verdict.
        assert.equal(
          result.verdict,
          "accepted",
          `run ${runIndex} should complete accepted; trace=${result.trace.join(" -> ")}`,
        );
        assert.ok(
          result.trace[result.trace.length - 1] === "complete:accepted",
          `run ${runIndex} terminal should be complete; trace=${result.trace.join(" -> ")}`,
        );

        // The full flow was traversed: the opening classifier spawn, all
        // three gates, and at least one parallel reviewer fanout.
        assert.equal(result.trace[0], "spawn:classifier");
        for (const gate of ["gate:gate-classify", "gate:gate-plan", "gate:gate-final"]) {
          assert.ok(result.trace.includes(gate), `run ${runIndex} should hit ${gate}`);
        }
        assert.ok(
          result.trace.some((t) => t.startsWith("parallel:")),
          `run ${runIndex} should hit a reviewer fanout`,
        );

        // Every spawn carried a materialized template body (no stub).
        for (const sp of result.spawnPrompts) {
          assert.ok(
            !sp.prompt.startsWith(`agent=${sp.agent}\n`),
            `spawn of '${sp.agent}' fell back to the no-template stub`,
          );
        }
        // Positive guard for the fanout path specifically: logic-reviewer is
        // fanned out (plan-review + review), and its prompt must be the real
        // template body — not just "not a stub".
        const logicReviewer = result.spawnPrompts.find((s) => s.agent === "logic-reviewer");
        assert.ok(logicReviewer !== undefined, `run ${runIndex} should fan out logic-reviewer`);
        assert.ok(
          logicReviewer.prompt.includes("# Agent: Logic Reviewer"),
          `run ${runIndex}: fanout-spawned logic-reviewer must carry its template body`,
        );

        // Each agent is spawned exactly once per stage — no re-emission
        // across the step-stages that sit between spawns.
        const singleSpawnStages = ["classifier", "code-analyzer", "planner", "implementer", "acceptance"];
        for (const agent of singleSpawnStages) {
          const count = result.spawnPrompts.filter((s) => s.agent === agent).length;
          assert.equal(count, 1, `agent '${agent}' spawned ${count}× (expected 1); trace=${result.trace.join(" -> ")}`);
        }
      } finally {
        h.dispose();
      }
    }
  });
});

describe("assembleRegistry — caching + idempotent reconcile", () => {
  it("caches per project: same dir returns one Registry, a different dir gets its own", async () => {
    _resetRegistryCacheForTest();
    const a = freshHarness("cacheA");
    const b = freshHarness("cacheB");
    try {
      const a1 = await assembleRegistry(a.dir);
      const a2 = await assembleRegistry(a.dir);
      const b1 = await assembleRegistry(b.dir);
      // Same project → the cached instance (built once per process).
      assert.strictEqual(a1, a2, "same project_dir must return the cached Registry");
      // The cache must not leak across projects.
      assert.notStrictEqual(a1, b1, "different project_dir must get its own Registry");
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  it("reconciling the bundle twice leaves exactly one enabled bundle row", async () => {
    const h = freshHarness("idem");
    try {
      await assembleRegistry(h.dir);
      // Drop the cache so the second call re-runs reconcile against a DB that
      // already carries the row — the path the idempotency guarantee protects.
      _resetRegistryCacheForTest();
      await assembleRegistry(h.dir);

      const db = openDb(h.dir);
      const row = db
        .prepare("SELECT COUNT(*) AS c FROM installed_extensions WHERE kind = 'bundle'")
        .get() as { c: number };
      const enabled = db
        .prepare(
          "SELECT COUNT(*) AS c FROM installed_extensions WHERE kind = 'bundle' AND status = 'enabled'",
        )
        .get() as { c: number };
      assert.equal(row.c, 1, "reconcile must not create a duplicate bundle row");
      assert.equal(enabled.c, 1, "the bundle must stay enabled after a second reconcile");
    } finally {
      h.dispose();
    }
  });
});

// ============================================================================
// First-run hardening — review shaping, gate escalation, finish-summary,
// phase progression, all end-to-end through the wired registry.
// ============================================================================

// A reviewer output carrying one open blocking finding.
function blockerOutput(agent: string): string {
  return JSON.stringify({
    verdict: "REQUEST_CHANGES",
    summary: "intentional blocker",
    findings: [
      { schema_version: "1.0", agent, iteration: 1, severity: "blocking", category: "correctness", summary: "intentional blocker" },
    ],
  });
}

const ON_BLOCKERS = { classify: "on-blockers", plan: "on-blockers", final: "on-blockers" };

interface DriveOpts {
  gatePolicies?: Record<string, string>;
  implementerFiles?: string[];
  // Paths the implementer COMMITS to the (git) project before its result
  // is delivered — with NO files reported on the carrier. Forces the
  // server to compute the delta from the committed tree, the path the
  // earlier hollow-green run exercised.
  commitAtImplementer?: string[];
  blockReviewFanout?: boolean;
  stopAtGateFinalAsk?: boolean;
}
interface DriveOut {
  trace: string[];
  verdict: string | null;
  summary: string | null;
  gateFinalAsked: boolean;
  reviewFanoutAgents: string[];
}

function isReviewFanout(agents: string[]): boolean {
  return agents.includes("challenger-reviewer") || agents.includes("performance") || agents.includes("style-reviewer");
}

async function drive(h: Harness, task: string, uuid: string, opts: DriveOpts): Promise<DriveOut> {
  const deps = { resolveRegistry: assembleRegistry, allowlistPath: h.allowlistPath };
  const run = createRunTaskTool(deps);
  const cont = createContinueTaskTool(deps);

  const first = await run({
    project_dir: h.dir,
    task,
    client_idempotency_uuid: uuid,
    ...(opts.gatePolicies !== undefined ? { gate_policies: opts.gatePolicies } : {}),
  });
  const dsid = first.driver_state_id ?? "";
  let resp: TransportResponse = first.response;
  const out: DriveOut = { trace: [], verdict: null, summary: null, gateFinalAsked: false, reviewFanoutAgents: [] };

  for (let step = 0; step < 120; step++) {
    if (resp.status === "complete") {
      out.verdict = resp.verdict;
      out.summary = resp.summary;
      out.trace.push(`complete:${resp.verdict}`);
      return out;
    }
    if (resp.status === "error") {
      assert.fail(`loop hit error: ${resp.code} — ${resp.message}`);
    }

    let input: Parameters<ReturnType<typeof createContinueTaskTool>>[0]["input"];
    if (resp.status === "spawn-agent") {
      out.trace.push(`spawn:${resp.agent}`);
      if (resp.agent === "implementer" && opts.commitAtImplementer !== undefined) {
        for (const rel of opts.commitAtImplementer) {
          commitFile(h.dir, rel, `// ${rel}\nexport {};\n`);
        }
      }
      const wantFiles = resp.agent === "implementer" && opts.implementerFiles !== undefined;
      input = {
        type: "agent-result",
        agent_run_id: resp.agent_run_id,
        agent_output: CANONICAL_AGENT_OUTPUT,
        ...(wantFiles ? { files_modified: opts.implementerFiles } : {}),
      };
    } else if (resp.status === "spawn-agents-parallel") {
      const agents = resp.spawns.map((s) => s.agent);
      out.trace.push(`parallel:[${agents.join(",")}]`);
      const review = isReviewFanout(agents);
      if (review) out.reviewFanoutAgents = agents;
      input = {
        type: "agents-results",
        results: resp.spawns.map((s) => ({
          agent_run_id: s.agent_run_id,
          // Block the logic reviewer on EVERY round it runs (the first full
          // panel AND the differentiated re-review that re-runs only the
          // reviewer that blocked) so the blocker PERSISTS — a one-shot blocker
          // would simply be cleared by the rework loop, which is the correct
          // outcome, not the "surviving blocker" this test means to exercise.
          agent_output:
            opts.blockReviewFanout === true && s.agent === "logic-reviewer"
              ? blockerOutput(s.agent)
              : CANONICAL_AGENT_OUTPUT,
        })),
      };
    } else if (resp.status === "ask-user") {
      out.trace.push(`gate:${resp.gate}`);
      if (resp.gate === "gate-final") {
        out.gateFinalAsked = true;
        if (opts.stopAtGateFinalAsk === true) return out;
      }
      input = { type: "user-answer", gate_event_id: resp.gate_event_id, decision: "accept" };
    } else {
      throw new Error(`drive cannot answer status '${(resp as { status: string }).status}'`);
    }

    const next = await cont({ project_dir: h.dir, driver_state_id: dsid, input });
    resp = next.response;
  }
  assert.fail(`drive did not terminate; trace=${out.trace.join(" -> ")}`);
}

describe("first-run hardening — end to end", () => {
  it("host-fed UI files flip ui_touched → the review fanout includes ui-consistency + playwright", async () => {
    _resetRegistryCacheForTest();
    const h = freshHarness("d1-ui");
    try {
      const withFiles = await drive(h, "restyle the dashboard", "d1-ui-1", {
        gatePolicies: ON_BLOCKERS,
        implementerFiles: ["src/App.tsx", "src/components/Button.tsx", "src/App.test.tsx"],
      });
      assert.equal(withFiles.verdict, "accepted");
      assert.ok(
        withFiles.reviewFanoutAgents.includes("ui-consistency"),
        `UI files should pull ui-consistency into the fanout; got ${withFiles.reviewFanoutAgents.join(",")}`,
      );
      assert.ok(
        withFiles.reviewFanoutAgents.includes("playwright"),
        `UI files should pull playwright into the fanout; got ${withFiles.reviewFanoutAgents.join(",")}`,
      );
    } finally {
      h.dispose();
    }
  });

  it("with no file accounting fed, the UI reviewers correctly drop out (proves the flag, not a constant)", async () => {
    _resetRegistryCacheForTest();
    const h = freshHarness("d1-nofiles");
    try {
      const noFiles = await drive(h, "restyle the dashboard", "d1-nofiles-1", {
        gatePolicies: ON_BLOCKERS,
      });
      assert.equal(noFiles.verdict, "accepted");
      assert.ok(
        !noFiles.reviewFanoutAgents.includes("ui-consistency"),
        "without files, ui_touched is false → ui-consistency is filtered out",
      );
      assert.ok(
        !noFiles.reviewFanoutAgents.includes("playwright"),
        "without files, ui_touched is false → playwright is filtered out",
      );
    } finally {
      h.dispose();
    }
  });

  it("COMMITTED UI work (no carrier reported) still flips ui_touched via the server-computed delta", async () => {
    _resetRegistryCacheForTest();
    const h = freshGitHarness("d-commit-ui");
    try {
      // The implementer commits UI files and reports NOTHING on the
      // carrier — exactly the shape that previously recorded an empty file
      // set and silently skipped the UI reviewers. The server now diffs the
      // committed tree against the task baseline and feeds the carrier.
      const committed = await drive(h, "restyle the dashboard", "d-commit-ui-1", {
        gatePolicies: ON_BLOCKERS,
        commitAtImplementer: ["src/App.tsx", "src/components/Button.tsx"],
      });
      assert.equal(committed.verdict, "accepted");
      assert.ok(
        committed.reviewFanoutAgents.includes("ui-consistency"),
        `committed UI work should pull ui-consistency into the fanout; got ${committed.reviewFanoutAgents.join(",")}`,
      );
      assert.ok(
        committed.reviewFanoutAgents.includes("playwright"),
        `committed UI work should pull playwright into the fanout; got ${committed.reviewFanoutAgents.join(",")}`,
      );
    } finally {
      h.dispose();
    }
  });

  it("a clean accepted run ends with completed phases, never all-skipped", async () => {
    _resetRegistryCacheForTest();
    const h = freshHarness("a4-phases");
    try {
      const res = await drive(h, "tidy the config loader", "a4-phases-1", { gatePolicies: ON_BLOCKERS });
      assert.equal(res.verdict, "accepted");
      const db = openDb(h.dir);
      const rows = db.prepare("SELECT name, status FROM phases").all() as { name: string; status: string }[];
      const completed = rows.filter((r) => r.status === "completed").map((r) => r.name);
      assert.ok(completed.length >= 1, `a clean run should show completed phases; got ${JSON.stringify(rows)}`);
      assert.ok(completed.includes("implementation"), "implementation should complete on a clean run");
      assert.ok(
        !rows.every((r) => r.status === "skipped"),
        "a clean run must not leave every phase skipped",
      );
    } finally {
      h.dispose();
    }
  });

  it("a stated commit step the engine does not perform is surfaced in the completion summary", async () => {
    _resetRegistryCacheForTest();
    const h = freshHarness("c2-commit");
    try {
      const res = await drive(h, "fix the date parser and commit the result", "c2-commit-1", { gatePolicies: ON_BLOCKERS });
      assert.equal(res.verdict, "accepted");
      assert.ok(
        (res.summary ?? "").includes("commit"),
        `summary should name the unperformed commit; got: ${res.summary}`,
      );
    } finally {
      h.dispose();
    }
  });

  it("a task with no finish-contract verb gets a plain completion summary", async () => {
    _resetRegistryCacheForTest();
    const h = freshHarness("c2-plain");
    try {
      const res = await drive(h, "rename a local variable for clarity", "c2-plain-1", { gatePolicies: ON_BLOCKERS });
      assert.equal(res.verdict, "accepted");
      assert.ok(!(res.summary ?? "").includes("run them yourself"), `plain summary expected; got: ${res.summary}`);
    } finally {
      h.dispose();
    }
  });

  it("the no-flag default applies the bundle on-blockers posture — a clean run asks no gate", async () => {
    _resetRegistryCacheForTest();
    const h = freshHarness("default-posture");
    try {
      // No gate_policies and no preset passed → the bundle's DECLARED
      // default (on-blockers) must apply. On a clean run that auto-resolves
      // every gate and completes with zero human round-trips — NOT the
      // all-human rubber-stamp the empty-map path produced before the
      // dispatcher's bundle-default tier landed. Reverting that tier reddens
      // this: the empty map would fall to the kernel `human` floor and every
      // gate would surface as ask-user.
      const res = await drive(h, "tidy the config loader", "default-posture-1", {});
      assert.equal(res.verdict, "accepted", `clean default run should complete; trace=${res.trace.join(" -> ")}`);
      assert.ok(
        !res.trace.some((t) => t.startsWith("gate:")),
        `clean no-flag run must auto-resolve every gate; trace=${res.trace.join(" -> ")}`,
      );
      assert.equal(res.gateFinalAsked, false, "no human is pulled in on a clean default run");
    } finally {
      h.dispose();
    }
  });

  it("an open blocker escalates the on-blockers final gate to a human — no silent PASS", async () => {
    _resetRegistryCacheForTest();
    const h = freshHarness("stuck");
    try {
      // Control: a clean run under the same on-blockers posture auto-approves
      // the final gate and completes — no human asked.
      const clean = await drive(h, "small cleanup", "stuck-clean-1", { gatePolicies: ON_BLOCKERS });
      assert.equal(clean.verdict, "accepted");
      assert.equal(clean.gateFinalAsked, false, "a clean run auto-approves the final gate");
    } finally {
      h.dispose();
    }

    _resetRegistryCacheForTest();
    const h2 = freshHarness("stuck2");
    try {
      // A surviving blocking finding from the review fanout: the on-blockers
      // final gate must escalate to a human, not silently pass.
      const blocked = await drive(h2, "small cleanup", "stuck-blocked-1", {
        gatePolicies: ON_BLOCKERS,
        // A real source change so the review fanout runs (an empty diff now skips
        // the panel) and can surface the injected blocker.
        implementerFiles: ["src/cleanup.ts"],
        blockReviewFanout: true,
        stopAtGateFinalAsk: true,
      });
      assert.equal(blocked.gateFinalAsked, true, "an open blocker must escalate the final gate to a human");
      assert.equal(blocked.verdict, null, "the run must not silently complete past an open blocker");
    } finally {
      h2.dispose();
    }
  });
});

// ============================================================================
// Safety floor is LIVE — a failing deterministic check refuses a silent
// full-autonomous accept, end-to-end.
//
// The FSM tick runs the active bundle's invariants, and the bundle now ships a
// deterministic writer for the floor's status fields (the checks runner +
// apply-checks). A FAILED check writes a `fail` status AND raises a blocking
// finding, so a `final: auto` drive cannot silently auto-approve past it — it is
// refused with INVARIANT_VIOLATION instead of reaching an accepted verdict. The
// honest-baseline flows above (clean / skipped checks) stay green, proving the
// floor refuses only where it should and never blocks a project that configured
// no checks.
// ============================================================================

interface TerminalOut {
  status: string;
  code: string | null;
  verdict: string | null;
}

// Drive every spawn/gate with the echo executor until a terminal directive
// (complete OR error) — unlike `drive`, this tolerates an error directive and
// returns it instead of failing, so a deliberate floor veto can be asserted.
async function driveCapturingTerminal(
  h: Harness,
  task: string,
  uuid: string,
  opts: { policyPreset?: string; gatePolicies?: Record<string, string>; implementerFiles?: string[]; failCheck?: boolean },
): Promise<TerminalOut> {
  const deps = { resolveRegistry: assembleRegistry, allowlistPath: h.allowlistPath };
  const run = createRunTaskTool(deps);
  const cont = createContinueTaskTool(deps);

  const first = await run({
    project_dir: h.dir,
    task,
    client_idempotency_uuid: uuid,
    ...(opts.policyPreset !== undefined ? { policy_preset: opts.policyPreset } : {}),
    ...(opts.gatePolicies !== undefined ? { gate_policies: opts.gatePolicies } : {}),
  });
  const dsid = first.driver_state_id ?? "";
  let resp: TransportResponse = first.response;

  for (let step = 0; step < 120; step++) {
    if (resp.status === "complete") return { status: "complete", code: null, verdict: resp.verdict };
    if (resp.status === "error") return { status: "error", code: resp.code, verdict: null };

    let input: Parameters<ReturnType<typeof createContinueTaskTool>>[0]["input"];
    if (resp.status === "spawn-agent") {
      const wantFiles = resp.agent === "implementer" && opts.implementerFiles !== undefined;
      // A failing deterministic-check envelope, echoed for the checks runner so
      // apply-checks records a real `fail` status + a blocking finding (the
      // executor's envelope shape the structured-output merge lands in
      // `decisions.checks`).
      const failOutput =
        opts.failCheck === true && resp.agent === "checks-runner"
          ? JSON.stringify({
              checks: [{ name: "test", status: "fail", exit_code: 1, output_head: "1 failing test", command: "node --test" }],
            })
          : undefined;
      input = {
        type: "agent-result",
        agent_run_id: resp.agent_run_id,
        agent_output: failOutput ?? CANONICAL_AGENT_OUTPUT,
        ...(wantFiles ? { files_modified: opts.implementerFiles } : {}),
      };
    } else if (resp.status === "spawn-agents-parallel") {
      input = {
        type: "agents-results",
        results: resp.spawns.map((s) => ({ agent_run_id: s.agent_run_id, agent_output: CANONICAL_AGENT_OUTPUT })),
      };
    } else if (resp.status === "ask-user") {
      input = { type: "user-answer", gate_event_id: resp.gate_event_id, decision: "accept" };
    } else {
      throw new Error(`driveCapturingTerminal cannot answer status '${(resp as { status: string }).status}'`);
    }
    const next = await cont({ project_dir: h.dir, driver_state_id: dsid, input });
    resp = next.response;
  }
  assert.fail("driveCapturingTerminal did not terminate");
}

describe("safety floor — live end to end", () => {
  it("a full-autonomous drive is VETOED when a deterministic check fails (the floor now runs)", async () => {
    _resetRegistryCacheForTest();
    const h = freshHarness("floor-auto");
    try {
      // The implementer reports a real file (so the empty-diff no-op park does
      // not pre-empt this), and the checks runner reports a FAILING check —
      // which writes a `fail` floor status and raises a blocking finding. Under
      // full autonomy the run must refuse to silently accept it.
      const out = await driveCapturingTerminal(h, "implement the feature", "floor-auto-1", {
        policyPreset: "full-autonomous",
        implementerFiles: ["src/feature.ts"],
        failCheck: true,
      });
      assert.equal(out.status, "error", "full-autonomy must not silently complete past a failed check");
      assert.equal(out.code, "INVARIANT_VIOLATION", "the safety floor / blocker rolls the auto-approve back");
      assert.notEqual(out.verdict, "accepted", "the run must not reach an accepted verdict");
    } finally {
      h.dispose();
    }
  });

  it("the same full-autonomous task completes when the checks are clean (the floor passes skipped checks)", async () => {
    _resetRegistryCacheForTest();
    const h = freshHarness("floor-clean");
    try {
      // Same full-autonomy posture, but NO failing check — the checks come back
      // skipped (nothing configured in the harness), which the floor treats as
      // passing, so the run completes. This is the crisp contrast to the veto
      // above: only the check outcome differs, proving the floor refuses a
      // failure without blocking a project that asked for no checks.
      const out = await driveCapturingTerminal(h, "implement the feature", "floor-clean-1", {
        policyPreset: "full-autonomous",
        implementerFiles: ["src/feature.ts"],
      });
      assert.equal(out.status, "complete", "a clean full-autonomous run completes");
      assert.equal(out.verdict, "accepted");
    } finally {
      h.dispose();
    }
  });
});

// ============================================================================
// C1 — complexity → flow selection (the classifier's signal routes the flow)
// ============================================================================

// Drive a task to terminal, returning the classifier-supplied `complexity`
// in its output so the kernel's post-classify flow switch keys on it. Every
// other spawn gets the canonical clean output.
async function driveWithComplexity(
  h: Harness,
  task: string,
  uuid: string,
  complexity: "simple" | "medium" | "complex",
  policyPreset?: string,
): Promise<{ trace: string[]; verdict: string | null }> {
  const deps = { resolveRegistry: assembleRegistry, allowlistPath: h.allowlistPath };
  const run = createRunTaskTool(deps);
  const cont = createContinueTaskTool(deps);

  const classifierOutput = JSON.stringify({
    schema_version: "1.1",
    agent: "classifier",
    task_short: "fixture",
    complexity,
    refs_to_load: [],
    security_needed: true,
    antipattern_rules_applicable: [],
  });

  const first = await run({
    project_dir: h.dir,
    task,
    client_idempotency_uuid: uuid,
    ...(policyPreset !== undefined ? { policy_preset: policyPreset } : {}),
  });
  const dsid = first.driver_state_id ?? "";
  let resp: TransportResponse = first.response;
  const trace: string[] = [];

  for (let step = 0; step < 120; step++) {
    if (resp.status === "complete") {
      trace.push(`complete:${resp.verdict}`);
      return { trace, verdict: resp.verdict };
    }
    if (resp.status === "error") {
      assert.fail(`loop hit error: ${resp.code} — ${resp.message}; trace=${trace.join(" -> ")}`);
    }
    let input: Parameters<ReturnType<typeof createContinueTaskTool>>[0]["input"];
    if (resp.status === "spawn-agent") {
      trace.push(`spawn:${resp.agent}`);
      input = {
        type: "agent-result",
        agent_run_id: resp.agent_run_id,
        agent_output: resp.agent === "classifier" ? classifierOutput : CANONICAL_AGENT_OUTPUT,
        // The implementer reports a source-file change so the run is not a no-op:
        // an empty diff now (correctly) skips the review panel + parks the final
        // gate, so a flow-routing test must produce a real change to exercise it.
        ...(resp.agent === "implementer" ? { files_modified: ["src/impl.ts"] } : {}),
      };
    } else if (resp.status === "spawn-agents-parallel") {
      trace.push(`parallel:[${resp.spawns.map((s) => s.agent).join(",")}]`);
      input = {
        type: "agents-results",
        results: resp.spawns.map((s) => ({
          agent_run_id: s.agent_run_id,
          agent_output: CANONICAL_AGENT_OUTPUT,
        })),
      };
    } else if (resp.status === "ask-user") {
      trace.push(`gate:${resp.gate}`);
      input = { type: "user-answer", gate_event_id: resp.gate_event_id, decision: "accept" };
    } else {
      throw new Error(`driveWithComplexity cannot answer status '${(resp as { status: string }).status}'`);
    }
    const next = await cont({ project_dir: h.dir, driver_state_id: dsid, input });
    resp = next.response;
  }
  assert.fail(`driveWithComplexity did not terminate; trace=${trace.join(" -> ")}`);
}

function readComplexity(dir: string): unknown {
  const db = openDb(dir);
  const row = db.prepare("SELECT decisions FROM pipeline_state WHERE id = 1").get() as
    | { decisions: string | null }
    | undefined;
  const parsed = JSON.parse(row?.decisions ?? "{}") as Record<string, unknown>;
  return parsed["complexity"];
}

describe("complexity → flow selection (C1)", () => {
  // A LONG (>400 char) but mechanical brief: the deterministic length seed
  // (`len > 400` → complex) would route this to the full panel, but the
  // classifier judges the actual change `simple`. Proves the SIGNAL — not
  // the plumbing — routes the flow.
  const VERBOSE_ROUTINE_TASK =
    "Update the copyright header year from 2025 to 2026 in the license banner comment at the top of " +
    "every source file in the utils directory. This is a purely mechanical text substitution: open each " +
    "file, find the single comment line that reads the old year, replace the four digits with the new " +
    "year, and save. No logic changes, no behavioral changes, no new dependencies, no test changes are " +
    "expected — only the comment banner is touched across the listed files in that one directory.";

  it("a verbose-but-routine task the classifier judges `simple` runs the lean flow to complete", async () => {
    _resetRegistryCacheForTest();
    const h = freshHarness("c1-simple");
    try {
      assert.ok(VERBOSE_ROUTINE_TASK.length > 400, "the task must be verbose enough to seed `complex`");
      // full-supervised so the gate the lean flow DOES keep (final) surfaces
      // as ask-user; the no-flag default would auto-resolve it on a clean run.
      const res = await driveWithComplexity(h, VERBOSE_ROUTINE_TASK, "c1-simple-1", "simple", "full-supervised");

      assert.equal(res.verdict, "accepted", `should complete accepted; trace=${res.trace.join(" -> ")}`);
      // The agent's `simple` overrode the length seed and routed the LEAN
      // flow: no classify/plan gates, and NO reviewer fanout at all.
      assert.equal(readComplexity(h.dir), "simple", "the classifier's complexity must win over the seed");
      assert.ok(!res.trace.includes("gate:gate-classify"), `lean flow has no gate-classify; trace=${res.trace.join(" -> ")}`);
      assert.ok(!res.trace.includes("gate:gate-plan"), `lean flow has no gate-plan; trace=${res.trace.join(" -> ")}`);
      assert.ok(
        !res.trace.some((t) => t.startsWith("parallel:")),
        `lean flow runs no fanout; trace=${res.trace.join(" -> ")}`,
      );
      // It still reviews (single logic-reviewer) and gates final + finishes.
      assert.ok(res.trace.includes("spawn:logic-reviewer"), "lean flow runs the single reviewer");
      assert.ok(res.trace.includes("gate:gate-final"), "lean flow still gates the final");
      // The heavy panel-only agents never spawn.
      assert.ok(!res.trace.includes("spawn:architect"), "lean flow does not run the architect");
      assert.ok(!res.trace.includes("spawn:code-analyzer"), "lean flow does not run enrich/code-analyzer");
    } finally {
      h.dispose();
    }
  });

  it("a task the classifier judges `complex` runs the full panel to complete", async () => {
    _resetRegistryCacheForTest();
    const h = freshHarness("c1-complex");
    try {
      // full-supervised so all three gates surface as ask-user for the
      // full-panel traversal assertions below.
      const res = await driveWithComplexity(h, "small tidy", "c1-complex-1", "complex", "full-supervised");

      assert.equal(res.verdict, "accepted", `should complete accepted; trace=${res.trace.join(" -> ")}`);
      assert.equal(readComplexity(h.dir), "complex");
      // The full panel: all three gates + at least one reviewer fanout + the
      // complexity-gated architect (applies_to complexity==='complex').
      assert.ok(res.trace.includes("gate:gate-classify"), `complex runs gate-classify; trace=${res.trace.join(" -> ")}`);
      assert.ok(res.trace.includes("gate:gate-plan"), `complex runs gate-plan; trace=${res.trace.join(" -> ")}`);
      assert.ok(res.trace.includes("gate:gate-final"), `complex runs gate-final; trace=${res.trace.join(" -> ")}`);
      assert.ok(
        res.trace.some((t) => t.startsWith("parallel:")),
        `complex runs a reviewer fanout; trace=${res.trace.join(" -> ")}`,
      );
      assert.ok(res.trace.includes("spawn:architect"), `complex runs the architect; trace=${res.trace.join(" -> ")}`);
    } finally {
      h.dispose();
    }
  });
});
