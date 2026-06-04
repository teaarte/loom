// `loom up` — the one-command start. These cover the up-only behaviour: the
// `--no-open` flag, browser-opening on listen, and pass-through of serve flags.
// The control plane itself is faked (an injected `startImpl`) so the test
// asserts wiring + reporting without binding a socket or standing up a backend.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { ControlPlaneHandle, ControlPlaneOptions } from "@loomfsm/server";

import { parseUpFlags, up, type UpOverrides } from "../src/commands/up.js";
import type { CliEnv } from "../src/lib/env.js";

function makeEnv(): { env: CliEnv; out: string[]; err: string[]; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "loom-up-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "loom-up-cwd-"));
  const out: string[] = [];
  const err: string[] = [];
  const env: CliEnv = { home, cwd, out: (l) => out.push(l), err: (l) => err.push(l) };
  return {
    env,
    out,
    err,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

// A fake control plane: it resolves immediately so `serve` returns, and records
// the options it was handed so a test can assert flag pass-through.
function fakeStart(seen: ControlPlaneOptions[]): NonNullable<UpOverrides["startImpl"]> {
  return async (opts: ControlPlaneOptions): Promise<ControlPlaneHandle> => {
    seen.push(opts);
    const handle = {
      host: opts.host ?? "127.0.0.1",
      port: opts.port ?? 4317,
      attached: [],
      stop: async () => {},
      closed: Promise.resolve(),
    };
    // The fields serve reads after start are host/port/attached/closed; the
    // registry/server handles are never touched on this path.
    return handle as unknown as ControlPlaneHandle;
  };
}

function baseOverrides(seen: ControlPlaneOptions[], opened: string[], stateDir: string): UpOverrides {
  return {
    startImpl: fakeStart(seen),
    openBrowser: (url) => opened.push(url),
    // Skip the production seams that would import bootstrap or probe the host.
    buildExecutor: () => ({ execute: async () => ({ agent_output: "" }) }),
    resolveRegistry: () => ({}) as never,
    invalidateRegistry: () => {},
    claudeAvailable: () => false,
    signal: new AbortController().signal,
    stateDir,
  };
}

describe("parseUpFlags", () => {
  it("strips --no-open and passes the rest through to serve", () => {
    assert.deepEqual(parseUpFlags(["--no-open", "--port", "9999"]), {
      serveArgs: ["--port", "9999"],
      noOpen: true,
    });
  });
  it("defaults noOpen to false", () => {
    assert.deepEqual(parseUpFlags([]), { serveArgs: [], noOpen: false });
  });
});

describe("loom up", () => {
  it("opens the browser at the served URL by default", async () => {
    const { env, cleanup } = makeEnv();
    const stateDir = mkdtempSync(join(tmpdir(), "loom-up-state-"));
    const seen: ControlPlaneOptions[] = [];
    const opened: string[] = [];
    try {
      const code = await up([], env, baseOverrides(seen, opened, stateDir));
      assert.equal(code, 0);
      assert.equal(opened.length, 1, "the browser is opened exactly once");
      assert.match(opened[0] ?? "", /^http:\/\/127\.0\.0\.1:\d+\/$/);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      cleanup();
    }
  });

  it("--no-open suppresses the browser but still serves", async () => {
    const { env, cleanup } = makeEnv();
    const stateDir = mkdtempSync(join(tmpdir(), "loom-up-state-"));
    const seen: ControlPlaneOptions[] = [];
    const opened: string[] = [];
    try {
      const code = await up(["--no-open"], env, baseOverrides(seen, opened, stateDir));
      assert.equal(code, 0);
      assert.equal(opened.length, 0, "no browser is opened");
      assert.equal(seen.length, 1, "the control plane still started");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      cleanup();
    }
  });

  it("forwards serve flags (port) to the control plane", async () => {
    const { env, cleanup } = makeEnv();
    const stateDir = mkdtempSync(join(tmpdir(), "loom-up-state-"));
    const seen: ControlPlaneOptions[] = [];
    const opened: string[] = [];
    try {
      const code = await up(["--no-open", "--port", "9876"], env, baseOverrides(seen, opened, stateDir));
      assert.equal(code, 0);
      assert.equal(seen[0]?.port, 9876, "the --port flag reached the control plane");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      cleanup();
    }
  });
});
