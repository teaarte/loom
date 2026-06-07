// `loom run` — the non-interactive driver command. These cover its parsing
// and outcome reporting with an injected drive / executor / registry (the
// real loop is exercised in @loomfsm/driver's own suite), plus the
// shuttle-provider guard and dispatcher routing.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { run } from "../src/cli.js";
import { runTask, type RunOverrides } from "../src/commands/run.js";
import type { CliEnv } from "../src/lib/env.js";

import type { DriveOutcome, Executor } from "@loomfsm/driver";
import type { Registry } from "@loomfsm/kernel";

function makeEnv(): { env: CliEnv; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const env: CliEnv = {
    home: "/tmp/nonexistent-home",
    cwd: "/tmp/nonexistent-cwd",
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { env, out, err };
}

const stubExecutor: Executor = { execute: async () => ({ agent_output: "" }) };

// Inject a registry + executor so no real store or Claude Code CLI is needed;
// the drive itself is faked per test to return the outcome under assertion.
function overrides(outcome: DriveOutcome): RunOverrides {
  return {
    resolveRegistry: () => ({}) as unknown as Registry,
    buildExecutor: () => stubExecutor,
    driveImpl: async () => outcome,
  };
}

describe("loom run", () => {
  it("reports a completed task and exits 0 on an accepted verdict", async () => {
    const { env, out } = makeEnv();
    const code = await runTask(
      ["ship", "the", "thing"],
      env,
      overrides({ kind: "complete", task_id: "t-1", verdict: "accepted", summary: "all green" }),
    );
    assert.equal(code, 0);
    assert.ok(out.some((l) => l.includes("done — accepted")));
    assert.ok(out.some((l) => l.includes("all green")));
  });

  it("exits 1 when the task completes with a non-accepted verdict", async () => {
    const { env } = makeEnv();
    const code = await runTask(
      ["risky work"],
      env,
      overrides({ kind: "complete", task_id: "t-2", verdict: "rejected", summary: "nope" }),
    );
    assert.equal(code, 1);
  });

  it("prints a human gate and exits 2 without answering it", async () => {
    const { env, out } = makeEnv();
    const code = await runTask(
      ["gated work"],
      env,
      overrides({
        kind: "paused",
        reason: "ask-user",
        driver_state_id: "d-1",
        gate: "approve-plan",
        gate_event_id: "gev-1",
        message: "Approve the plan?",
        valid_answers: {
          options: [{ verbs: ["yes"], label: "Approve", produces: { decision: "accept" } }],
        },
      }),
    );
    assert.equal(code, 2);
    assert.ok(out.some((l) => l.includes("paused at gate 'approve-plan'")));
    assert.ok(out.some((l) => l.includes("Approve the plan?")));
  });

  it("reports an error outcome on stderr and exits 1", async () => {
    const { env, err } = makeEnv();
    const code = await runTask(
      ["broken work"],
      env,
      overrides({
        kind: "error",
        driver_state_id: "d-1",
        code: "SPAWN_BUDGET_EXCEEDED",
        message: "too slow",
        recovery_options: [],
      }),
    );
    assert.equal(code, 1);
    assert.ok(err.some((l) => l.includes("SPAWN_BUDGET_EXCEEDED")));
  });

  it("requires a task description", async () => {
    const { env, err } = makeEnv();
    const code = await runTask([], env, overrides({ kind: "complete", task_id: null, verdict: "accepted", summary: "" }));
    assert.equal(code, 1);
    assert.ok(err.some((l) => /task is required/.test(l)));
  });

  it("refuses cleanly when no agent has a usable backend (Claude Code absent, default auto)", async () => {
    const { env, err } = makeEnv();
    // No buildExecutor override → the dispatch preflight runs: with `auto`
    // routing, an agent that has no configured provider needs Claude Code, and
    // an injected "not found" probe makes that unresolvable → refuse before any
    // drive begins, with a message that names Claude Code.
    const code = await runTask(["some work"], env, {
      resolveRegistry: () =>
        ({ bundle: { name: "code" }, agents: new Map([["a", {}]]) }) as unknown as Registry,
      claudeAvailable: () => false,
      driveImpl: async () => ({ kind: "complete", task_id: null, verdict: "accepted", summary: "" }),
    });
    assert.equal(code, 1);
    assert.ok(err.some((l) => /Claude Code CLI/.test(l)));
  });

  it("is routed by the dispatcher (a bare 'run' asks for a task)", async () => {
    const { env, err } = makeEnv();
    const code = await run(["run"], env);
    assert.equal(code, 1);
    assert.ok(err.some((l) => /task is required/.test(l)));
  });

  it("rejects --docker and --no-docker together", async () => {
    const { env, err } = makeEnv();
    const code = await runTask(
      ["--docker", "--no-docker", "work"],
      env,
      overrides({ kind: "complete", task_id: "t", verdict: "accepted", summary: "" }),
    );
    assert.equal(code, 1);
    assert.ok(err.some((l) => /mutually exclusive/.test(l)));
  });

  it("strips the container toggle from the task string", async () => {
    const { env } = makeEnv();
    let seenTask: string | undefined;
    const code = await runTask(["--docker", "ship", "it"], env, {
      resolveRegistry: () => ({}) as unknown as Registry,
      buildExecutor: () => stubExecutor,
      driveImpl: async (_dir, opts) => {
        seenTask = opts.task;
        return { kind: "complete", task_id: "t", verdict: "accepted", summary: "" };
      },
    });
    assert.equal(code, 0);
    assert.equal(seenTask, "ship it");
  });

  it("refuses cleanly when --docker is required but Docker is absent", async () => {
    const { env, err } = makeEnv();
    // No buildExecutor override → the default builder resolves the container
    // plan; require mode + an absent Docker probe refuses before any drive.
    const code = await runTask(["--docker", "some work"], env, {
      resolveRegistry: () => ({}) as unknown as Registry,
      dockerAvailable: () => false,
      driveImpl: async () => ({ kind: "complete", task_id: null, verdict: "accepted", summary: "" }),
    });
    assert.equal(code, 1);
    assert.ok(err.some((l) => /--docker requires/.test(l)));
  });

  it("pins complexity via --complexity, strips it, and seeds the pin decisions", async () => {
    const { env } = makeEnv();
    let seenTask: string | undefined;
    let seenDecisions: Record<string, unknown> | undefined;
    const code = await runTask(["--complexity", "simple", "do", "the", "thing"], env, {
      resolveRegistry: () => ({}) as unknown as Registry,
      buildExecutor: () => stubExecutor,
      driveImpl: async (_dir, opts) => {
        seenTask = opts.task;
        seenDecisions = opts.initial_decisions;
        return { kind: "complete", task_id: "t", verdict: "accepted", summary: "" };
      },
    });
    assert.equal(code, 0);
    assert.equal(seenTask, "do the thing");
    assert.deepEqual(seenDecisions, { complexity: "simple", complexity_pinned: true });
  });

  it("accepts the --complexity=<level> form", async () => {
    const { env } = makeEnv();
    let seenDecisions: Record<string, unknown> | undefined;
    await runTask(["--complexity=medium", "work"], env, {
      resolveRegistry: () => ({}) as unknown as Registry,
      buildExecutor: () => stubExecutor,
      driveImpl: async (_dir, opts) => {
        seenDecisions = opts.initial_decisions;
        return { kind: "complete", task_id: "t", verdict: "accepted", summary: "" };
      },
    });
    assert.deepEqual(seenDecisions, { complexity: "medium", complexity_pinned: true });
  });

  it("rejects an invalid --complexity level", async () => {
    const { env, err } = makeEnv();
    const code = await runTask(
      ["--complexity", "huge", "work"],
      env,
      overrides({ kind: "complete", task_id: "t", verdict: "accepted", summary: "" }),
    );
    assert.equal(code, 1);
    assert.ok(err.some((l) => /--complexity needs one of/.test(l)));
  });

  it("does not seed pin decisions when --complexity is absent", async () => {
    const { env } = makeEnv();
    let seenDecisions: Record<string, unknown> | undefined = { sentinel: true };
    await runTask(["plain", "work"], env, {
      resolveRegistry: () => ({}) as unknown as Registry,
      buildExecutor: () => stubExecutor,
      driveImpl: async (_dir, opts) => {
        seenDecisions = opts.initial_decisions;
        return { kind: "complete", task_id: "t", verdict: "accepted", summary: "" };
      },
    });
    assert.equal(seenDecisions, undefined);
  });
});
