import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  KernelError,
  captureNow,
  closeDb,
} from "../src/state.js";
import {
  buildPrompt,
  loadBundle,
  materializeTemplates,
  reconcileExtensions,
} from "../src/index.js";
import type { ExtensionManifest } from "../src/types/extension.js";
import type { RenderedTemplate } from "../src/types/extension.js";
import type { Bundle } from "../src/types/bundle.js";
import type { NowToken } from "../src/types/now.js";
import type { Agent } from "../src/types/plugins.js";
import type { PolicyName } from "../src/types/policy.js";
import type { LLMProvider } from "../src/types/provider.js";
import type { GateRole } from "../src/types/row-types.js";
import type { Registry } from "../src/types/registry.js";
import type { PipelineState } from "../src/types/state.js";

// ============================================================================
// Fixtures
// ============================================================================

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), "loom-prompt-renderer-proj-"));
}

function freshBundleDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-prompt-renderer-src-"));
  mkdirSync(join(dir, "agents"));
  return dir;
}

function cleanup(projectDir: string): void {
  try { closeDb(projectDir); } catch { /* may have already closed */ }
  rmSync(projectDir, { recursive: true, force: true });
}

function stubProvider(name = "stub"): LLMProvider {
  return {
    name,
    capabilities: { execution: "shuttle", idempotent_spawn: true, reports_usage: true },
    async spawn() { throw new Error("stub — spawn must not run in loader tests"); },
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
// substitution + the appended spawn-context block) plus driver_state_id
// and decisions (block-only). A partial cast is sufficient to exercise
// the pure render path (mirrors the `{} as PipelineState` pattern used
// elsewhere in the suite); decisions defaults to `{}` exactly as the DB
// hydration does.
function stateStub(
  o: {
    task?: string;
    project_dir?: string;
    task_short?: string | null;
    task_id?: string | null;
    driver_state_id?: string;
    decisions?: Record<string, unknown>;
  } = {},
): PipelineState {
  return {
    task: o.task ?? "Add a health endpoint",
    project_dir: o.project_dir ?? "/work/proj",
    // `in` (not `??`) so an explicit null survives — the renderer must
    // treat a null task_short as the empty string.
    task_short: "task_short" in o ? o.task_short : "health-endpoint",
    task_id: "task_id" in o ? o.task_id : "task-1",
    driver_state_id: o.driver_state_id ?? "ds-1",
    decisions: o.decisions ?? {},
  } as unknown as PipelineState;
}

// buildPrompt only touches `registry.prompts`; a minimal cast keeps the
// pure-render tests independent of the full Registry shape.
function registryWith(prompts: Map<string, RenderedTemplate>): Registry {
  return { prompts } as unknown as Registry;
}

// ============================================================================
// materializeTemplates — load-time file read + frontmatter strip
// ============================================================================

describe("materializeTemplates", () => {
  let bundleDir: string;
  beforeEach(() => { bundleDir = freshBundleDir(); });
  afterEach(() => { rmSync(bundleDir, { recursive: true, force: true }); });

  it("reads each agent template into the map keyed by agent name", () => {
    writeTemplate(bundleDir, "planner", "# Planner\nPlan {{task}}.\n");
    writeTemplate(bundleDir, "implementer", "# Implementer\nBuild it.\n");

    const prompts = materializeTemplates(
      makeBundle([agent("planner"), agent("implementer")]),
      bundleDir,
    );

    assert.equal(prompts.size, 2);
    assert.equal(prompts.get("planner")?.body, "# Planner\nPlan {{task}}.\n");
    assert.equal(prompts.get("implementer")?.body, "# Implementer\nBuild it.\n");
    // A plain body has no declared prefix / budget.
    assert.equal(prompts.get("planner")?.system_prompt, undefined);
    assert.equal(prompts.get("planner")?.context_budget, undefined);
  });

  it("strips a frontmatter block and surfaces its declared fields", () => {
    writeTemplate(
      bundleDir,
      "reviewer",
      [
        "---",
        "system_prompt: You are a careful reviewer.",
        "context_budget:",
        "  soft_threshold_tokens: 1200",
        "  hard_threshold_tokens: 4096",
        "---",
        "# Reviewer",
        "Review {{task}}.",
        "",
      ].join("\n"),
    );

    const t = materializeTemplates(makeBundle([agent("reviewer")]), bundleDir).get("reviewer");

    assert.ok(t !== undefined);
    assert.equal(t.body, "# Reviewer\nReview {{task}}.\n");
    assert.equal(t.system_prompt, "You are a careful reviewer.");
    assert.deepEqual(t.context_budget, {
      soft_threshold_tokens: 1200,
      hard_threshold_tokens: 4096,
    });
  });

  it("throws TEMPLATE_NOT_FOUND when an agent template file is missing", () => {
    // No file written for 'ghost'.
    assert.throws(
      () => materializeTemplates(makeBundle([agent("ghost")]), bundleDir),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "TEMPLATE_NOT_FOUND");
        assert.equal((err as KernelError).detail?.["agent"], "ghost");
        assert.equal((err as KernelError).detail?.["template_path"], "agents/ghost.md");
        return true;
      },
    );
  });
});

// ============================================================================
// buildPrompt — pure, synchronous render
// ============================================================================

describe("buildPrompt — pure render", () => {
  it("substitutes the context variables into the materialized body", () => {
    const prompts = new Map<string, RenderedTemplate>([
      ["planner", { agent: "planner", body: "Plan {{task}} in {{project_dir}} ({{task_short}})." }],
    ]);
    const out = buildPrompt(
      stateStub({ task: "ship X", project_dir: "/srv/app", task_short: "ship-x" }),
      agent("planner"),
      registryWith(prompts),
    );
    // The substituted body leads; the kernel-built spawn-context block is
    // appended after it (asserted in its own describe block below).
    assert.ok(out.startsWith("Plan ship X in /srv/app (ship-x)."));
  });

  it("is byte-identical on repeat for the same state (replay determinism)", () => {
    const prompts = new Map<string, RenderedTemplate>([
      ["planner", { agent: "planner", body: "Plan {{task}} for {{project_dir}}." }],
    ]);
    const state = stateStub();
    const a = buildPrompt(state, agent("planner"), registryWith(prompts));
    const b = buildPrompt(state, agent("planner"), registryWith(prompts));
    assert.equal(a, b);
  });

  it("changes when the template body changes", () => {
    const state = stateStub({ task: "T", project_dir: "/p", task_short: "ts" });
    const first = buildPrompt(
      state,
      agent("x"),
      registryWith(new Map([["x", { agent: "x", body: "Do {{task}}." }]])),
    );
    const second = buildPrompt(
      state,
      agent("x"),
      registryWith(new Map([["x", { agent: "x", body: "Do {{task}} now ({{task_short}})." }]])),
    );
    assert.notEqual(first, second);
    assert.ok(first.startsWith("Do T."));
    assert.ok(second.startsWith("Do T now (ts)."));
  });

  it("leaves unknown {{tokens}} untouched (later binding layers own them)", () => {
    const out = buildPrompt(
      stateStub(),
      agent("x"),
      registryWith(new Map([["x", { agent: "x", body: "{{task}} :: {{findings.count}}" }]])),
    );
    assert.ok(out.includes("{{findings.count}}"));
  });

  it("inserts a null task_short as the empty string", () => {
    const out = buildPrompt(
      stateStub({ task: "T", task_short: null }),
      agent("x"),
      registryWith(new Map([["x", { agent: "x", body: "[{{task_short}}]" }]])),
    );
    assert.ok(out.startsWith("[]"));
  });

  it("falls back to the deterministic stub when no materialized template exists", () => {
    const out = buildPrompt(
      stateStub({ task_id: "task-9" }),
      agent("planner"),
      registryWith(new Map()),
    );
    // The stub carries identifying fields, NOT the (absent) body.
    assert.ok(out.includes("agent=planner"));
    assert.ok(out.includes("task_id=task-9"));
    assert.ok(out.includes("template=agents/planner.md"));
  });
});

// ============================================================================
// buildPrompt — appended `## Spawn context` block
// ============================================================================

// Count markdown `## Spawn context` HEADINGs (line-anchored) — not prose
// mentions of the string. Mirrors the renderer's idempotency guard.
function spawnContextHeadingCount(s: string): number {
  return (s.match(/^##[ \t]+Spawn context\b/gm) ?? []).length;
}

describe("buildPrompt — spawn context block", () => {
  function rendered(
    state: PipelineState,
    body = "# Agent\nDo the work.\n",
  ): string {
    return buildPrompt(
      state,
      agent("x"),
      registryWith(new Map([["x", { agent: "x", body }]])),
    );
  }

  it("carries the heading, the verbatim task, and task_id under Canonical identifiers", () => {
    const out = rendered(
      stateStub({
        task: "Add a /healthz endpoint that returns 200",
        task_id: "task-42",
        driver_state_id: "ds-abc",
      }),
    );
    assert.ok(out.includes("## Spawn context"), "block heading present");
    assert.ok(out.includes("### Canonical identifiers"), "ids subsection present");
    assert.ok(out.includes("### Task description"), "task subsection present");
    // task_id lives under the Canonical identifiers subsection, ahead of
    // the task description — the order the classifier is told to read.
    const idsAt = out.indexOf("### Canonical identifiers");
    const taskAt = out.indexOf("### Task description");
    assert.ok(out.indexOf("- task_id: task-42") > idsAt);
    assert.ok(out.indexOf("- task_id: task-42") < taskAt);
    assert.ok(out.includes("- driver_state_id: ds-abc"));
    // The task appears verbatim under its subsection.
    assert.ok(out.includes("Add a /healthz endpoint that returns 200"));
  });

  it("omits the Task (short) subsection when task_short is null", () => {
    const withShort = rendered(stateStub({ task_short: "health-endpoint" }));
    const withoutShort = rendered(stateStub({ task_short: null }));
    assert.ok(withShort.includes("### Task (short)\nhealth-endpoint"));
    assert.ok(!withoutShort.includes("### Task (short)"));
  });

  it("renders decisions as sorted key: value lines (byte-stable re-render)", () => {
    // Insertion order is deliberately NOT sorted — the block must sort.
    const state = stateStub({
      decisions: {
        security_needed: true,
        change_kind: "logic",
        task_short: "health-endpoint",
        refs_count: 3,
      },
    });
    const a = rendered(state);
    const b = rendered(state);
    // Determinism: identical state → byte-identical prompt.
    assert.equal(a, b);
    assert.ok(a.includes("### Decisions so far"));
    // Keys appear sorted by code unit: change_kind < refs_count <
    // security_needed < task_short.
    const order = ["change_kind", "refs_count", "security_needed", "task_short"]
      .map((k) => a.indexOf(`- ${k}:`));
    for (let i = 1; i < order.length; i++) {
      assert.ok(order[i - 1]! >= 0 && order[i]! > order[i - 1]!, "decisions sorted");
    }
    // String values render verbatim; non-strings are JSON-encoded.
    assert.ok(a.includes("- change_kind: logic"));
    assert.ok(a.includes("- security_needed: true"));
    assert.ok(a.includes("- refs_count: 3"));
  });

  it("marks an empty decisions map as '(none yet)'", () => {
    const out = rendered(stateStub({ decisions: {} }));
    assert.ok(out.includes("### Decisions so far\n(none yet)"));
  });

  it("appends exactly one block — a template that authored its own heading is left alone", () => {
    const authored = "# Agent\n## Spawn context\nThe author wrote this themselves.\n";
    const out = rendered(stateStub(), authored);
    assert.equal(spawnContextHeadingCount(out), 1, "no double-append");
    // The author's content is preserved; the kernel block was NOT added,
    // so the kernel's Canonical-identifiers subsection is absent.
    assert.ok(out.includes("The author wrote this themselves."));
    assert.ok(!out.includes("### Canonical identifiers"));
  });

  it("still appends when the template only MENTIONS the string in prose", () => {
    // Mirrors the real classifier template, which references
    // `` `## Spawn context` `` inside a list item to point the agent at
    // the block. A prose mention is not a heading — the block is appended.
    const prose = "# Classifier\n- **Task description** — under `## Spawn context`.\n";
    const out = rendered(stateStub({ task: "classify me" }), prose);
    assert.equal(spawnContextHeadingCount(out), 1, "block appended despite the prose mention");
    assert.ok(out.includes("### Canonical identifiers"));
    assert.ok(out.includes("classify me"));
  });

  it("does NOT append the block to the no-template stub", () => {
    const out = buildPrompt(stateStub(), agent("planner"), registryWith(new Map()));
    assert.ok(out.startsWith("agent=planner"));
    assert.ok(!out.includes("## Spawn context"));
  });
});

// ============================================================================
// loadBundle — materialization wired into the cascade
// ============================================================================

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

    const registry = await loadBundle({
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

    const registry = await loadBundle({
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
