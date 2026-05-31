// Per-agent provider routing through the production registry assembly.
//
// Proves the wired path: a project's `.claude/providers.json` is read at
// registry build and threaded into the kernel router, so `resolve(agent)`
// returns the routed provider + model. Uses `createAssembleRegistry` — the
// injectable factory the entrypoint uses — with stub providers, so no real
// backend is touched. The provider SET is the deployment's choice; the
// per-agent routing is the project's.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { closeDb } from "@loomfsm/kernel";
import type { LLMProvider, PipelineState } from "@loomfsm/kernel";

import { createAssembleRegistry } from "../src/bootstrap.js";

function stub(name: string): LLMProvider {
  return {
    name,
    capabilities: { execution: "shuttle", idempotent_spawn: true, reports_usage: true },
    async spawn() {
      throw new Error(`stub '${name}' — spawn must not run in routing tests`);
    },
  };
}

function freshDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `loom-prov-${label}-`));
}
function dispose(dir: string): void {
  try {
    closeDb(dir);
  } catch {
    /* may already be closed */
  }
  rmSync(dir, { recursive: true, force: true });
}
function writeProvidersJson(dir: string, config: unknown): void {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "providers.json"), JSON.stringify(config), "utf8");
}

const anyState = {} as unknown as PipelineState;

describe("assembleRegistry — per-agent provider routing from .claude/providers.json", () => {
  it("routes the configured agent to its provider + tier model; others use the default", async () => {
    const dir = freshDir("route");
    try {
      writeProvidersJson(dir, {
        agent_routing: { classifier: { provider: "routed", tier: "t" } },
        tier_aliases: { t: { model: "routed-model" } },
        default_provider: "base",
      });
      const assemble = createAssembleRegistry([stub("base"), stub("routed")]);
      const registry = await assemble(dir);

      assert.equal(registry.providers.resolve("classifier", anyState).name, "routed");
      assert.equal(registry.providers.resolveModel?.("classifier", anyState), "routed-model");
      // An agent with no route → the configured default.
      assert.equal(registry.providers.resolve("planner", anyState).name, "base");
    } finally {
      dispose(dir);
    }
  });

  it("with no providers.json, every agent resolves to the single registered provider", async () => {
    const dir = freshDir("none");
    try {
      const assemble = createAssembleRegistry([stub("solo")]);
      const registry = await assemble(dir);
      assert.equal(registry.providers.resolve("classifier", anyState).name, "solo");
      assert.equal(registry.providers.resolveModel?.("classifier", anyState), null);
    } finally {
      dispose(dir);
    }
  });

  it("surfaces a malformed providers.json as an error rather than ignoring it", async () => {
    const dir = freshDir("bad");
    try {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, ".claude", "providers.json"), "{ not valid json", "utf8");
      const assemble = createAssembleRegistry([stub("solo")]);
      await assert.rejects(assemble(dir), /invalid provider routing config/);
    } finally {
      dispose(dir);
    }
  });
});
