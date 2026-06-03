// Per-spawn backend dispatch — the CLI seam that turns stored config (backend
// mode + per-agent model map + secrets) into per-agent execution. These exercise
// the REAL resolver over a REAL config store (a temp $LOOM_HOME, no mocked DB),
// with backend EXECUTOR construction stubbed (no real SDK / Claude Code CLI) —
// the stub just tags which backend each spawn routed to.
//
// Genericity: the bundle name + agent names are a FABRICATED non-code roster
// (`research-bundle` / `oracle` / `writer` / `local` / `ghost`). The dispatch
// reads them as DATA — it hardcodes no bundle, agent, or tier — so a second
// (non-code) bundle's decision-agent routes to a non-Claude backend with zero
// code-bundle assumption. That is the genericity acceptance for this path.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { writeGlobalConfig, writeSecrets, type LoomConfig } from "@loomfsm/config";
import type { Executor } from "@loomfsm/driver";
import type { ProviderShuttleIntent } from "@loomfsm/kernel";

import { buildDispatchExecutor, preflightDispatch } from "../src/lib/dispatch.js";

const BUNDLE = "research-bundle";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "loom-dispatch-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function intent(agent: string): ProviderShuttleIntent {
  return {
    agent,
    agent_run_id: `ar-${agent}`,
    phase: "review",
    model: "ignored-by-stub",
    prompt: "decide",
  };
}

function dispatcher(opts: {
  config: LoomConfig;
  ccAvailable: boolean;
  built?: string[];
  notices?: string[];
}): Executor {
  writeGlobalConfig(home, opts.config);
  return buildDispatchExecutor({
    projectDir: join(home, "proj"),
    resolveBundleName: () => BUNDLE,
    env: { LOOM_HOME: home },
    home,
    plan: { useDocker: false },
    timeouts: {},
    claudeAvailable: () => opts.ccAvailable,
    onNotice: (m) => opts.notices?.push(m),
    onUsage: () => {},
    // Tag which backend was built (and route to it) without a real SDK / CLI.
    buildBackendExecutor: (backend) => {
      opts.built?.push(backend);
      return { execute: async () => ({ agent_output: backend }) };
    },
  });
}

describe("buildDispatchExecutor — per-spawn routing over a real config store", () => {
  it("routes mixed backends in one drive by each agent's model family (auto, CC present)", async () => {
    const built: string[] = [];
    const exec = dispatcher({
      config: {
        backend: "auto",
        bundles: {
          [BUNDLE]: {
            agents: {
              oracle: "openrouter:deepseek",
              writer: "anthropic:claude-sonnet",
              local: "ollama:llama3",
            },
          },
        },
      },
      ccAvailable: true,
      built,
    });

    assert.equal((await exec.execute(intent("oracle"))).agent_output, "openrouter");
    assert.equal((await exec.execute(intent("writer"))).agent_output, "claude-code"); // anthropic + CC present
    assert.equal((await exec.execute(intent("local"))).agent_output, "ollama");
    // An agent with no configured model has no family → auto → CC-first.
    assert.equal((await exec.execute(intent("ghost"))).agent_output, "claude-code");

    // Each backend built once and cached (no rebuild on a second spawn).
    assert.equal((await exec.execute(intent("oracle"))).agent_output, "openrouter");
    assert.deepEqual([...built].sort(), ["claude-code", "ollama", "openrouter"]);
  });

  it("falls back anthropic → anthropic-sdk with a loud notice when Claude Code is absent", async () => {
    const notices: string[] = [];
    const exec = dispatcher({
      config: { backend: "auto", bundles: { [BUNDLE]: { agents: { writer: "anthropic:claude-sonnet" } } } },
      ccAvailable: false,
      notices,
    });
    assert.equal((await exec.execute(intent("writer"))).agent_output, "anthropic-sdk");
    assert.ok(notices.some((n) => /falling back to 'anthropic-sdk'/.test(n)));
  });

  it("errors per-spawn for an unconfigured agent when Claude Code is absent (no usable backend)", async () => {
    const exec = dispatcher({
      config: { backend: "auto", bundles: { [BUNDLE]: { agents: {} } } },
      ccAvailable: false,
    });
    await assert.rejects(() => exec.execute(intent("ghost")), /no usable backend/);
  });

  it("validates an explicit pin per spawn: compatible runs, incompatible is refused", async () => {
    const exec = dispatcher({
      config: {
        backend: "openrouter",
        bundles: { [BUNDLE]: { agents: { oracle: "openrouter:deepseek", writer: "anthropic:claude-sonnet" } } },
      },
      ccAvailable: true,
    });
    assert.equal((await exec.execute(intent("oracle"))).agent_output, "openrouter");
    // A pinned openrouter backend cannot run an anthropic model → clean refusal.
    await assert.rejects(() => exec.execute(intent("writer")), /can't run a anthropic model/);
  });
});

describe("preflightDispatch — upfront refusal over a real config store", () => {
  it("passes when at least one agent has a usable backend", () => {
    writeGlobalConfig(home, {
      backend: "auto",
      bundles: { [BUNDLE]: { agents: { oracle: "openrouter:deepseek" } } },
    });
    const pre = preflightDispatch({
      projectDir: join(home, "proj"),
      env: { LOOM_HOME: home },
      home,
      bundleName: BUNDLE,
      agents: ["oracle", "ghost"],
      claudeAvailable: () => false,
    });
    assert.deepEqual(pre, { ok: true });
  });

  it("refuses when EVERY agent is unresolvable (default auto, Claude Code absent)", () => {
    writeGlobalConfig(home, { backend: "auto" });
    const pre = preflightDispatch({
      projectDir: join(home, "proj"),
      env: { LOOM_HOME: home },
      home,
      bundleName: BUNDLE,
      agents: ["ghost"],
      claudeAvailable: () => false,
    });
    assert.equal(pre.ok, false);
    if (pre.ok) return;
    assert.match(pre.error, /Claude Code CLI/);
  });
});

describe("credential store feeds the raw backend (secret by reference, not literal)", () => {
  it("routes to the openrouter backend with the secret present in the real store", async () => {
    // secrets.json holds the value; config references the backend by name — the
    // literal never lands in config.json. (The credential read itself is unit-
    // tested in @loomfsm/config; here we confirm dispatch reaches the backend.)
    writeSecrets(home, { OPENROUTER_API_KEY: "sk-real-secret-value" });
    const built: string[] = [];
    const exec = dispatcher({
      config: { backend: "openrouter", bundles: { [BUNDLE]: { agents: { oracle: "openrouter:deepseek" } } } },
      ccAvailable: false,
      built,
    });
    assert.equal((await exec.execute(intent("oracle"))).agent_output, "openrouter");
  });
});
