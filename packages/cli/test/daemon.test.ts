// `loom daemon` — the supervisor control command. Covers subcommand routing,
// outcome reporting (with an injected supervise so no real store / Claude Code
// is needed), the claude-absent refusal, and the stop/status read-only paths.
// The supervisor's real behaviour is exercised in @loomfsm/daemon's own suite.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { run } from "../src/cli.js";
import { daemon, type DaemonOverrides } from "../src/commands/daemon.js";
import type { CliEnv } from "../src/lib/env.js";

import type { Executor } from "@loomfsm/driver";
import type { Registry } from "@loomfsm/kernel";

function makeEnv(cwd: string): { env: CliEnv; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const env: CliEnv = {
    home: "/tmp/nonexistent-home",
    cwd,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { env, out, err };
}

const stubExecutor: Executor = { execute: async () => ({ agent_output: "" }) };

// A non-aborted injected signal makes `start` skip the real OS signal
// handlers and use the test's controller instead.
function baseStartOverrides(result: unknown): DaemonOverrides {
  return {
    resolveRegistry: () => ({}) as unknown as Registry,
    buildExecutor: () => stubExecutor,
    superviseImpl: async () => result,
    signal: new AbortController().signal,
  };
}

function withTempCwd(fn: (cwd: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "loom-cli-daemon-"));
  return (async () => {
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

describe("loom daemon — routing", () => {
  it("rejects a missing/bad subcommand with guidance", async () => {
    const { env, err } = makeEnv("/tmp/nonexistent-cwd");
    assert.equal(await daemon([], env), 1);
    assert.ok(err.some((l) => /expected 'start', 'stop', or 'status'/.test(l)));
    const second = makeEnv("/tmp/nonexistent-cwd");
    assert.equal(await daemon(["frobnicate"], second.env), 1);
  });

  it("is reachable through the top-level dispatcher", async () => {
    const { env, err } = makeEnv("/tmp/nonexistent-cwd");
    const code = await run(["daemon", "bogus"], env);
    assert.equal(code, 1);
    assert.ok(err.some((l) => /expected 'start'/.test(l)));
  });
});

describe("loom daemon start — reporting", () => {
  it("reports a completed task and the merge-back branch, exits 0", async () => {
    await withTempCwd(async (cwd) => {
      const { env, out } = makeEnv(cwd);
      const code = await daemon(
        ["start", "ship", "it"],
        env,
        baseStartOverrides({
          kind: "complete",
          task_id: "t-1",
          verdict: "accepted",
          summary: "all green",
          merge_back: { merged: true, branch: "loom/t-1", files_changed: ["a.ts", "b.ts"] },
          attempts: 0,
        }),
      );
      assert.equal(code, 0);
      assert.ok(out.some((l) => l.includes("done — accepted")));
      assert.ok(out.some((l) => l.includes("branch loom/t-1")));
    });
  });

  it("exits 1 when the supervisor escalates an error", async () => {
    await withTempCwd(async (cwd) => {
      const { env, err } = makeEnv(cwd);
      const code = await daemon(
        ["start", "doomed work"],
        env,
        baseStartOverrides({ kind: "error", code: "EXECUTOR_FAILED", message: "backend down", attempts: 5 }),
      );
      assert.equal(code, 1);
      assert.ok(err.some((l) => l.includes("EXECUTOR_FAILED")));
    });
  });

  it("refuses cleanly when no agent has a usable backend (Claude Code absent, default auto)", async () => {
    await withTempCwd(async (cwd) => {
      const { env, err } = makeEnv(cwd);
      // No buildExecutor override → the dispatch preflight runs: with `auto`
      // routing an unconfigured agent needs Claude Code, and an injected "not
      // found" probe makes it unresolvable → refuse before any supervision.
      const code = await daemon(["start", "some work"], env, {
        resolveRegistry: () =>
          ({ bundle: { name: "code" }, agents: new Map([["a", {}]]) }) as unknown as Registry,
        claudeAvailable: () => false,
        signal: new AbortController().signal,
      });
      assert.equal(code, 1);
      assert.ok(err.some((l) => /Claude Code CLI/.test(l)));
    });
  });
});

describe("loom daemon stop / status — no running daemon", () => {
  it("status reports not-running for a clean project", async () => {
    await withTempCwd(async (cwd) => {
      const { env, out } = makeEnv(cwd);
      assert.equal(await daemon(["status"], env), 0);
      assert.ok(out.some((l) => /not running/.test(l)));
    });
  });

  it("stop reports no running daemon for a clean project", async () => {
    await withTempCwd(async (cwd) => {
      const { env, out } = makeEnv(cwd);
      assert.equal(await daemon(["stop"], env), 0);
      assert.ok(out.some((l) => /no running daemon/.test(l)));
    });
  });
});
