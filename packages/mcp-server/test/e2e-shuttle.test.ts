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

import { closeDb, openDb } from "@loom/kernel";
import type { TransportResponse } from "@loom/transport-types";

import { _resetRegistryCacheForTest, assembleRegistry } from "../src/bootstrap.js";
import { createContinueTaskTool, createRunTaskTool } from "../src/index.js";

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

  const trace: string[] = [];
  const spawnPrompts: { agent: string; prompt: string }[] = [];

  const first = await run({
    project_dir: h.dir,
    task,
    client_idempotency_uuid: `e2e-${task}`,
  });
  const driverStateId = first.driver_state_id ?? "";
  let resp: TransportResponse = first.response;
  recordSpawnPrompts(resp, spawnPrompts);

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
    recordSpawnPrompts(resp, spawnPrompts);
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

function recordSpawnPrompts(
  resp: TransportResponse,
  into: { agent: string; prompt: string }[],
): void {
  if (resp.status === "spawn-agent") {
    into.push({ agent: resp.agent, prompt: resp.spawn_request.prompt });
  } else if (resp.status === "spawn-agents-parallel") {
    for (const s of resp.spawns) into.push({ agent: s.agent, prompt: s.spawn_request.prompt });
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
        const prompt = res.response.spawn_request.prompt;
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
      }
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
