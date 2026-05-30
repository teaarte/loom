import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  KernelError,
  captureNow,
  closeDb,
  loadBundle,
  reconcileExtensions,
} from "@loom/kernel";
import type { Bundle, LLMProvider, NowToken } from "@loom/kernel";

import codeBundle from "../src/bundle.js";
import codeManifest from "../manifest.js";

// The compiled test lives at dist/test/; the package root (where agents/,
// schemas/, src/ and manifest.ts sit) is two levels up.
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "loom-bundle-code-"));
}

function cleanup(dir: string): void {
  try {
    closeDb(dir);
  } catch {
    /* may already be closed */
  }
  rmSync(dir, { recursive: true, force: true });
}

function shuttleStub(name = "claude-code-shuttle"): LLMProvider {
  return {
    name,
    capabilities: { execution: "shuttle", idempotent_spawn: true, reports_usage: true },
    async spawn() {
      throw new Error("stub — spawn must not run in loader tests");
    },
  };
}

async function installManifest(dir: string, now: NowToken): Promise<void> {
  await reconcileExtensions({
    manifests: [{ path: "/fixture/manifest.json", raw: codeManifest }],
    project_dir: dir,
    now,
  });
}

// ============================================================================
// Happy path — the real bundle registers without error
// ============================================================================

describe("@loom/bundle-code — loadBundle", () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("registers the migrated manifest + bundle into a populated Registry", async () => {
    const now = captureNow();
    await installManifest(projectDir, now);

    const registry = await loadBundle({
      bundle: codeBundle,
      bundle_source_dir: PKG_ROOT,
      project_dir: projectDir,
      providers: [shuttleStub()],
      now,
    });

    // 21 canonical agents (the source's 24 minus the three CC-harness
    // trigger agents).
    assert.equal(registry.agents.size, 21);
    // Every agent's `.md` is read off disk into the prompt map at load.
    assert.equal(registry.prompts?.size, 21);
    assert.ok((registry.prompts?.get("classifier")?.body.length ?? 0) > 0);
    assert.equal(registry.flows.size, 3);
    assert.deepEqual(
      registry.flows.get("medium"),
      [
        "initialize", "classify", "classify-agent", "gate-classify",
        "enrich", "plan", "plan-review", "gate-plan",
        "git-stash", "implement", "git-diff", "pre-review", "review",
        "reconcile", "iterate", "final-checks", "test-verify",
        "gate-final", "finalize",
      ],
    );
    // Two post-commit observers, eight domain + floor invariants.
    assert.equal(registry.hooks.length, 2);
    assert.equal(registry.invariants.length, 8);
    // Vocabulary merged the bundle's error_classes onto the kernel set.
    assert.ok(registry.vocabularies.error_classes.has("impl-blockers"));
    assert.ok(registry.vocabularies.gate_roles.has("classify"));
  });

});

// ============================================================================
// Every agent in agents[] has a backing template .md on disk
// ============================================================================

describe("@loom/bundle-code — agent templates", () => {
  it("every agents[] entry resolves to an existing .md template file", () => {
    for (const agent of codeBundle.agents) {
      const abs = join(PKG_ROOT, agent.template_path);
      assert.ok(
        existsSync(abs) && statSync(abs).isFile(),
        `agent '${agent.name}' template missing: ${agent.template_path}`,
      );
    }
  });

  it("declares exactly the 21 canonical agents", () => {
    assert.equal(codeBundle.agents.length, 21);
    const names = codeBundle.agents.map((a) => a.name).sort();
    // The three CC-harness trigger agents are NOT bundle agents.
    for (const excluded of ["fe-test-all-agent", "runtime-debug-agent", "test-all-agent"]) {
      assert.ok(!names.includes(excluded), `${excluded} must not be a bundle agent`);
    }
  });

  it("maps each gate to its intended kernel role", () => {
    // The loader accepts ANY valid role per gate, so a valid-but-wrong swap
    // (e.g. gate-plan -> "final") loads fine yet is a real bug. Pin the
    // intended mapping here, which load does not guarantee.
    assert.deepEqual(codeBundle.gate_roles, {
      "gate-classify": "classify",
      "gate-plan": "plan",
      "gate-final": "final",
    });
  });
});

// ============================================================================
// Refusals — the load test must FAIL when the bundle shape is broken
// ============================================================================

describe("@loom/bundle-code — load-time refusals", () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("refuses an orphan stage name in a flow (BUNDLE_FLOW_UNKNOWN_STAGE)", async () => {
    const now = captureNow();
    await installManifest(projectDir, now);

    const broken: Bundle = {
      ...codeBundle,
      flows: {
        ...codeBundle.flows,
        medium: [...(codeBundle.flows["medium"] ?? []), "ghost-stage"],
      },
    };

    await assert.rejects(
      loadBundle({
        bundle: broken,
        bundle_source_dir: PKG_ROOT,
        project_dir: projectDir,
        providers: [shuttleStub()],
        now,
      }),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "BUNDLE_FLOW_UNKNOWN_STAGE");
        assert.equal((err as KernelError).detail?.["missing_stage"], "ghost-stage");
        return true;
      },
    );
  });

  it("refuses a gate whose role is neither kernel-known nor declared (GATE_ROLE_UNKNOWN)", async () => {
    const now = captureNow();
    await installManifest(projectDir, now);

    const broken: Bundle = {
      ...codeBundle,
      gate_roles: { ...codeBundle.gate_roles, "gate-final": "bogus-role" },
    };

    await assert.rejects(
      loadBundle({
        bundle: broken,
        bundle_source_dir: PKG_ROOT,
        project_dir: projectDir,
        providers: [shuttleStub()],
        now,
      }),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "GATE_ROLE_UNKNOWN");
        assert.equal((err as KernelError).detail?.["role"], "bogus-role");
        return true;
      },
    );
  });

  it("refuses an agent whose template .md is missing on disk (TEMPLATE_NOT_FOUND)", async () => {
    const now = captureNow();
    await installManifest(projectDir, now);

    const broken: Bundle = {
      ...codeBundle,
      agents: [
        ...codeBundle.agents,
        { name: "phantom", template_path: "agents/phantom.md", output_kind: "nonreview" },
      ],
    };

    await assert.rejects(
      loadBundle({
        bundle: broken,
        bundle_source_dir: PKG_ROOT,
        project_dir: projectDir,
        providers: [shuttleStub()],
        now,
      }),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "TEMPLATE_NOT_FOUND");
        assert.equal((err as KernelError).detail?.["agent"], "phantom");
        return true;
      },
    );
  });

  it("refuses a spawn stage referencing an undeclared agent (BUNDLE_AGENT_UNKNOWN)", async () => {
    const now = captureNow();
    await installManifest(projectDir, now);

    const broken: Bundle = {
      ...codeBundle,
      stages: {
        ...codeBundle.stages,
        implement: { kind: "spawn", name: "implement", phase: "implementation", agent: "ghost-agent" },
      },
    };

    await assert.rejects(
      loadBundle({
        bundle: broken,
        bundle_source_dir: PKG_ROOT,
        project_dir: projectDir,
        providers: [shuttleStub()],
        now,
      }),
      (err: unknown) => {
        assert.equal((err as KernelError).code, "BUNDLE_AGENT_UNKNOWN");
        assert.equal((err as KernelError).detail?.["agent"], "ghost-agent");
        return true;
      },
    );
  });
});

// ============================================================================
// Auto-readiness — flipping the final role to `auto` loads cleanly because
// the resolver + the named safety-floor invariant are both shipped.
// ============================================================================

describe("@loom/bundle-code — full-autonomous readiness", () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = freshProject();
  });
  afterEach(() => cleanup(projectDir));

  it("loads cleanly when the final role is overridden to auto", async () => {
    const now = captureNow();
    await installManifest(projectDir, now);

    const autoFinal: Bundle = {
      ...codeBundle,
      default_gate_policies: { ...codeBundle.default_gate_policies, final: "auto" },
    };

    const registry = await loadBundle({
      bundle: autoFinal,
      bundle_source_dir: PKG_ROOT,
      project_dir: projectDir,
      providers: [shuttleStub()],
      now,
    });
    // The resolver + INV_safety_floor_final satisfied the auto-policy gate.
    assert.ok(registry.invariants.some((inv) => (inv as { name?: string }).name === "INV_safety_floor_final"));
  });
});
