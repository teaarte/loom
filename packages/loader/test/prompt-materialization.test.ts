// loadBundle wires prompt materialization into the cascade — the build-time
// half of the prompt-renderer story. (The pure render path + materializeTemplates
// / materializeContextAssets unit tests stay with the renderer in the kernel
// suite; this exercises loadBundle reading templates off `bundle_source_dir`
// into Registry.prompts, refusing a missing template at load, and the empty-map
// fallback when no source dir is supplied.)

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { loadBundle, reconcileExtensions } from "../src/index.js";
import { KernelError, buildPrompt, captureNow, closeDb } from "@loomfsm/kernel";
import type {
  Agent,
  Bundle,
  ExtensionManifest,
  GateRole,
  LLMProvider,
  NowToken,
  PipelineState,
  PolicyName,
  Registry,
} from "@loomfsm/kernel";

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "loom-prompt-mat-proj-"));
}

function freshBundleDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-prompt-mat-src-"));
  mkdirSync(join(dir, "agents"));
  return dir;
}

function cleanup(projectDir: string): void {
  try {
    closeDb(projectDir);
  } catch {
    /* may have already closed */
  }
  rmSync(projectDir, { recursive: true, force: true });
}

function stubProvider(name = "stub"): LLMProvider {
  return {
    name,
    capabilities: { execution: "shuttle", idempotent_spawn: true, reports_usage: true },
    async spawn() {
      throw new Error("stub — spawn must not run in materialization tests");
    },
  };
}

function makeManifest(overrides?: Partial<ExtensionManifest>): ExtensionManifest {
  return {
    manifest_version: "1.0",
    name: "code",
    display_name: "Code pipeline",
    description: "Code task workflows.",
    version: "3.0.0",
    kind: "bundle",
    publisher: "@loom",
    capabilities: ["state.read"],
    requires: { kernel_api: "^3.0" },
    ...overrides,
  };
}

async function installManifest(projectDir: string, now: NowToken): Promise<void> {
  await reconcileExtensions({
    manifests: [{ path: "/fixture/manifest.json", raw: makeManifest() }],
    project_dir: projectDir,
    now,
  });
}

function agent(name: string): Agent {
  return { name, template_path: `agents/${name}.md`, output_kind: "nonreview" };
}

function makeBundle(agents: Agent[]): Bundle {
  return {
    name: "code",
    version: "3.0.0",
    description: "fixture",
    phases: ["p1"],
    default_flow: "default",
    default_gate_policies: {} as Record<GateRole, PolicyName>,
    agents,
    stages: {},
    flows: { default: [] },
    hooks: [],
    invariants: [],
    gate_roles: {},
  };
}

function writeTemplate(bundleDir: string, name: string, body: string): void {
  writeFileSync(join(bundleDir, "agents", `${name}.md`), body);
}

// buildPrompt reads task / project_dir / task_short / task_id (for the
// substitution + the appended spawn-context block) plus driver_state_id and
// decisions. A partial cast suffices for the render-after-load assertions.
function stateStub(o: { task?: string } = {}): PipelineState {
  return {
    task: o.task ?? "Add a health endpoint",
    project_dir: "/work/proj",
    task_short: "health-endpoint",
    task_id: "task-1",
    driver_state_id: "ds-1",
    decisions: {},
    driver: undefined,
  } as unknown as PipelineState;
}

describe("loadBundle — prompt materialization", () => {
  let projectDir: string;
  let bundleDir: string;
  beforeEach(() => {
    projectDir = freshProject();
    bundleDir = freshBundleDir();
  });
  afterEach(() => {
    cleanup(projectDir);
    rmSync(bundleDir, { recursive: true, force: true });
  });

  it("populates Registry.prompts from bundle_source_dir", async () => {
    const now = captureNow();
    await installManifest(projectDir, now);
    writeTemplate(bundleDir, "classifier", "# Classifier\nClassify {{task}}.\n");
    writeTemplate(bundleDir, "planner", "# Planner\nPlan it.\n");

    const registry: Registry = await loadBundle({
      bundle: makeBundle([agent("classifier"), agent("planner")]),
      bundle_source_dir: bundleDir,
      project_dir: projectDir,
      providers: [stubProvider()],
      now,
    });

    assert.equal(registry.prompts?.size, 2);
    assert.equal(registry.prompts?.get("classifier")?.body, "# Classifier\nClassify {{task}}.\n");

    // End-to-end: the rendered prompt carries the body + substituted task.
    const rendered = buildPrompt(
      stateStub({ task: "wire health" }),
      agent("classifier"),
      registry,
    );
    assert.ok(rendered.startsWith("# Classifier"));
    assert.ok(rendered.includes("Classify wire health."));
  });

  it("refuses at load with TEMPLATE_NOT_FOUND when a template is missing on disk", async () => {
    const now = captureNow();
    await installManifest(projectDir, now);
    // Only one of the two templates exists on disk.
    writeTemplate(bundleDir, "classifier", "# Classifier\n");

    await assert.rejects(
      loadBundle({
        bundle: makeBundle([agent("classifier"), agent("planner")]),
        bundle_source_dir: bundleDir,
        project_dir: projectDir,
        providers: [stubProvider()],
        now,
      }),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "TEMPLATE_NOT_FOUND");
        assert.equal((err as KernelError).detail?.["agent"], "planner");
        return true;
      },
    );
  });

  it("leaves Registry.prompts empty when bundle_source_dir is omitted (stub fallback)", async () => {
    const now = captureNow();
    await installManifest(projectDir, now);

    const registry: Registry = await loadBundle({
      bundle: makeBundle([agent("classifier")]),
      // bundle_source_dir intentionally omitted
      project_dir: projectDir,
      providers: [stubProvider()],
      now,
    });

    assert.equal(registry.prompts?.size, 0);
    const rendered = buildPrompt(stateStub(), agent("classifier"), registry);
    assert.ok(rendered.includes("agent=classifier"));
    assert.ok(rendered.includes("template=agents/classifier.md"));
  });
});
