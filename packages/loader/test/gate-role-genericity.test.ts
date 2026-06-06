// The loader cascade must accept a bundle whose gate roles are entirely its
// own — none of the three kernel-shipped role literals. This is the build-time
// half of the gate-role genericity guard (the kernel's own suite proves the
// TICK PATH drives such a bundle to finalize): loadBundle, on a FABRICATED
// non-code roster, validates the shape and assembles a Registry whose gate
// policy map names none of classify/plan/final.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { loadBundle, reconcileExtensions } from "../src/index.js";
import { captureNow, closeDb } from "@loomfsm/kernel";
import type { Bundle, ExtensionManifest, LLMProvider, NowToken } from "@loomfsm/kernel";

const BUNDLE_NAME = "gate-genericity-fixture";

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "loom-gate-genericity-loader-"));
}

function cleanup(projectDir: string): void {
  try {
    closeDb(projectDir);
  } catch {
    /* may have already closed */
  }
  rmSync(projectDir, { recursive: true, force: true });
}

function stubProvider(): LLMProvider {
  return {
    name: "stub",
    capabilities: { execution: "shuttle", idempotent_spawn: true, reports_usage: true },
    async spawn() {
      throw new Error("stub — spawn must not run in this test");
    },
  };
}

// The non-code bundle. Its roles are `scope` / `consult` / `spec-approval`;
// the gate routes to `spec-approval`. No baseline role appears anywhere in the
// gate-policy map.
function makeNonCodeBundle(): Bundle {
  return {
    name: BUNDLE_NAME,
    version: "0.0.0",
    description: "non-code gate-role genericity fixture",
    phases: ["review"],
    default_flow: "default",
    default_gate_policies: {
      scope: "human",
      consult: "human",
      "spec-approval": "on-blockers",
    },
    agents: [],
    stages: {
      "approval-gate": {
        kind: "gate",
        name: "approval-gate",
        phase: "review",
        message: () => "approve?",
        valid_answers: () => ({ options: [] }),
      },
      finalize: { kind: "finalize", name: "finalize" },
    },
    flows: { default: ["approval-gate", "finalize"] },
    hooks: [],
    invariants: [],
    gate_roles: { "approval-gate": "spec-approval" },
    extends_vocab: { gate_roles_extra: ["scope", "consult", "spec-approval"] },
  };
}

function makeManifest(): ExtensionManifest {
  return {
    manifest_version: "1.0",
    name: BUNDLE_NAME,
    display_name: "Gate-role genericity fixture",
    description: "non-code gate-role genericity fixture",
    version: "0.0.0",
    kind: "bundle",
    publisher: "@loom",
    capabilities: ["state.read"],
    requires: { kernel_api: "^3.0" },
  };
}

async function installManifest(projectDir: string, now: NowToken): Promise<void> {
  await reconcileExtensions({
    manifests: [{ path: "/fixture/manifest.json", raw: makeManifest() }],
    project_dir: projectDir,
    now,
  });
}

describe("gate-role genericity (loader) — the cascade accepts a non-baseline roster", () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("loads a bundle whose gate-policy map names none of classify/plan/final", async () => {
    const now = captureNow();
    await installManifest(projectDir, now);

    const registry = await loadBundle({
      bundle: makeNonCodeBundle(),
      project_dir: projectDir,
      providers: [stubProvider()],
      now,
    });

    assert.ok(registry.flows.has("default"));
    assert.equal(registry.bundle.default_gate_policies["spec-approval"], "on-blockers");
    // The map is the bundle's own — the three kernel roles are simply absent.
    assert.equal(registry.bundle.default_gate_policies["classify"], undefined);
    assert.equal(registry.bundle.default_gate_policies["plan"], undefined);
    assert.equal(registry.bundle.default_gate_policies["final"], undefined);
  });
});
