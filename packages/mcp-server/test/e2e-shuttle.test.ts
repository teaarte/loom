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
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

interface DriveResult {
  trace: string[];
  verdict: string | null;
  spawnPrompts: { agent: string; prompt: string }[];
}

// Drive a fresh task to its terminal directive with the echo executor.
// Returns the directive trace, the final verdict, and every prompt the
// host would have run (so a caller can assert real template bodies).
async function driveToComplete(h: Harness, task: string): Promise<DriveResult> {
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

  it("fanout directives carry prompts by reference — response size is bounded, not the sum of prompts", async () => {
    _resetRegistryCacheForTest();
    const h = freshHarness("byref");
    try {
      const deps = { resolveRegistry: assembleRegistry, allowlistPath: h.allowlistPath };
      const run = createRunTaskTool(deps);
      const cont = createContinueTaskTool(deps);
      const getPrompt = createGetSpawnPromptTool(deps);

      const first = await run({
        project_dir: h.dir,
        task: "harden the auth layer against brute force",
        client_idempotency_uuid: "e2e-byref-1",
      });
      const driverStateId = first.driver_state_id ?? "";
      let resp: TransportResponse = first.response;

      const fanouts: { count: number; bytes: number }[] = [];
      // Body fetched by reference from the widest fanout, captured WHILE the
      // fanout is pending (the host fetches before delivering — once the
      // batch is delivered the pending row drains and the reference is gone).
      let widestFetchedBody = "";
      let widestCount = 0;

      for (let step = 0; step < 80 && resp.status !== "complete" && resp.status !== "error"; step++) {
        if (resp.status === "spawn-agents-parallel") {
          // Every fanout entry must omit the inline prompt and flag the
          // by-reference contract — the bulky prompt never rides the wire.
          assert.equal(resp.prompts_by_reference, true, "fanout must set prompts_by_reference");
          for (const s of resp.spawns) {
            assert.equal(
              s.spawn_request.prompt,
              undefined,
              `fanout spawn '${s.agent}' must not inline its prompt`,
            );
          }
          fanouts.push({ count: resp.spawns.length, bytes: JSON.stringify(resp).length });
          if (resp.spawns.length > widestCount) {
            widestCount = resp.spawns.length;
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

      // The medium flow fans out at least twice (plan-review = 2 agents,
      // review = up to 5). The widest must still be small: with prompts by
      // reference the envelope is a list of {agent_run_id, agent, model,
      // extras}, so a few hundred bytes per agent — orders of magnitude
      // under the ~84k an inlined 4-way fanout produced. A fixed ceiling
      // that holds regardless of how wide the fanout grows.
      assert.ok(fanouts.length >= 1, "expected at least one reviewer fanout");
      const widest = fanouts.reduce((m, f) => (f.count > m.count ? f : m), fanouts[0]!);
      assert.ok(widest.count >= 2, `widest fanout should have ≥2 agents; got ${widest.count}`);
      assert.ok(
        widest.bytes < 4000,
        `by-reference fanout response must stay small; ${widest.count} agents → ${widest.bytes} bytes`,
      );

      // The reference is resolvable: the prompt fetched mid-fanout is the
      // real materialized template body, not a stub.
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
        const result = await driveToComplete(h, `fix-${runIndex}`);

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
        results: resp.spawns.map((s, idx) => ({
          agent_run_id: s.agent_run_id,
          agent_output:
            opts.blockReviewFanout === true && review && idx === 0
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
