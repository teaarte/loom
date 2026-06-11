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

import { KernelError } from "../src/state.js";
import {
  buildPrompt,
  materializeContextAssets,
  materializeTemplates,
} from "../src/index.js";
import type { RenderedContextAsset, RenderedTemplate } from "../src/types/extension.js";
import type { Bundle } from "../src/types/bundle.js";
import type { Agent, Stage } from "../src/types/plugins.js";
import type { PolicyName } from "../src/types/policy.js";
import type { GateRole } from "../src/types/row-types.js";
import type { Registry } from "../src/types/registry.js";
import type { PipelineState } from "../src/types/state.js";

// ============================================================================
// Fixtures
// ============================================================================

function freshBundleDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-prompt-renderer-src-"));
  mkdirSync(join(dir, "agents"));
  return dir;
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
    flow_name?: string;
    open_blockers?: unknown;
  } = {},
): PipelineState {
  // Build the driver row only when a test exercises it (a flow for the
  // active-agents section, or an open-blocker snapshot for the rework
  // hand-off); omitted otherwise so the pure-render tests keep their shape.
  const scratch: Record<string, unknown> = {};
  if (o.open_blockers !== undefined) scratch["open_blockers"] = o.open_blockers;
  const driver =
    o.flow_name != null || o.open_blockers !== undefined
      ? { flow_name: o.flow_name, scratch }
      : undefined;
  return {
    task: o.task ?? "Add a health endpoint",
    project_dir: o.project_dir ?? "/work/proj",
    // `in` (not `??`) so an explicit null survives — the renderer must
    // treat a null task_short as the empty string.
    task_short: "task_short" in o ? o.task_short : "health-endpoint",
    task_id: "task_id" in o ? o.task_id : "task-1",
    driver_state_id: o.driver_state_id ?? "ds-1",
    decisions: o.decisions ?? {},
    driver,
  } as unknown as PipelineState;
}

// buildPrompt only touches `registry.prompts`; a minimal cast keeps the
// pure-render tests independent of the full Registry shape.
function registryWith(prompts: Map<string, RenderedTemplate>): Registry {
  return { prompts } as unknown as Registry;
}

// Richer registry for the spawn-context-block tests that exercise the
// active-agents roster + bundle context assets.
function fullRegistry(o: {
  prompts?: Map<string, RenderedTemplate>;
  context_assets?: RenderedContextAsset[];
  flows?: Record<string, string[]>;
  stages?: Record<string, Stage>;
}): Registry {
  return {
    prompts: o.prompts ?? new Map<string, RenderedTemplate>([["x", { agent: "x", body: "# Agent\n" }]]),
    context_assets: o.context_assets,
    flows: o.flows ? new Map(Object.entries(o.flows)) : undefined,
    stages: o.stages ? new Map(Object.entries(o.stages)) : undefined,
  } as unknown as Registry;
}

function spawnStage(name: string, agent: string): Stage {
  return { kind: "spawn", name, phase: "p1", agent };
}
function fanoutStage(name: string, agents: string[]): Stage {
  return { kind: "fanout", name, phase: "p1", agents };
}

// Write a frontmatter reference file under `<bundleDir>/knowledge/references`.
function writeRef(bundleDir: string, name: string, frontmatter: string, body = ""): void {
  mkdirSync(join(bundleDir, "knowledge", "references"), { recursive: true });
  writeFileSync(
    join(bundleDir, "knowledge", "references", name),
    `---\n${frontmatter}\n---\n${body}`,
  );
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

  it("renders the Open blockers section from the driver-scratch snapshot", () => {
    const out = rendered(
      stateStub({
        open_blockers: [
          {
            file: "src/orders.ts",
            line: 42,
            category: "correctness",
            summary: "P2002 not caught — duplicate order 500s",
            suggested_fix: "wrap create() in try/catch on P2002",
            agent: "logic-reviewer",
          },
          {
            file: null,
            line: null,
            category: "security",
            summary: "no authz check on the new route",
            suggested_fix: null,
            agent: "security",
          },
        ],
      }),
    );
    assert.ok(out.includes("### Open blockers"), "section present");
    assert.ok(
      out.includes("- [correctness] src/orders.ts:42: P2002 not caught — duplicate order 500s — suggested fix: wrap create() in try/catch on P2002"),
    );
    // A blocker with no file/fix renders the location placeholder and no fix tail.
    assert.ok(out.includes("- [security] (no file): no authz check on the new route"));
    assert.ok(!out.includes("(no file): no authz check on the new route — suggested fix:"));
  });

  it("omits the Open blockers section when the snapshot is empty or absent", () => {
    assert.ok(!rendered(stateStub({ open_blockers: [] })).includes("### Open blockers"));
    assert.ok(!rendered(stateStub()).includes("### Open blockers"));
  });

  it("is byte-identical on re-render with an open-blocker snapshot (determinism)", () => {
    const state = stateStub({
      open_blockers: [
        { file: "a.ts", line: 1, category: "x", summary: "s", suggested_fix: null, agent: "logic-reviewer" },
      ],
    });
    assert.equal(rendered(state), rendered(state));
  });
});

// ============================================================================
// materializeContextAssets — load-time bundle-asset read
// ============================================================================

describe("materializeContextAssets", () => {
  let bundleDir: string;
  beforeEach(() => { bundleDir = freshBundleDir(); });
  afterEach(() => { rmSync(bundleDir, { recursive: true, force: true }); });

  function bundleWithAssets(assets: NonNullable<Bundle["spawn_context_assets"]>): Bundle {
    const b = makeBundle([]);
    b.spawn_context_assets = assets;
    return b;
  }

  it("renders a frontmatter-catalog: sorted FILE entries, verbatim frontmatter, bodies excluded", () => {
    writeRef(bundleDir, "beta.md", "summary: B\nwhen_to_load: later", "# Beta BODY EXCLUDED");
    writeRef(bundleDir, "alpha.md", "tags: [x]\nsummary: A", "# Alpha BODY EXCLUDED");

    const assets = materializeContextAssets(
      bundleWithAssets([
        { heading: "Refs catalog", kind: "frontmatter-catalog", dir: "knowledge/references", agents: ["classifier"] },
      ]),
      bundleDir,
    );

    assert.equal(assets.length, 1);
    const a = assets[0]!;
    assert.equal(a.heading, "Refs catalog");
    assert.deepEqual(a.agents, ["classifier"]);
    // Sorted by filename → alpha before beta (byte-stable).
    assert.ok(
      a.body.indexOf("FILE: knowledge/references/alpha.md") <
        a.body.indexOf("FILE: knowledge/references/beta.md"),
    );
    // Frontmatter passes through verbatim; the body is excluded.
    assert.ok(a.body.includes("summary: A"));
    assert.ok(a.body.includes("when_to_load: later"));
    assert.ok(!a.body.includes("BODY EXCLUDED"));
  });

  it("inlines a file asset verbatim in a fenced block", () => {
    writeFileSync(join(bundleDir, "stack.yaml"), "languages:\n  - name: typescript\n");
    const [a] = materializeContextAssets(
      bundleWithAssets([{ heading: "Stack candidate registry", kind: "file", path: "stack.yaml", fence: "yaml" }]),
      bundleDir,
    );
    assert.ok(a !== undefined);
    assert.ok(a.body.startsWith("```yaml\n"));
    assert.ok(a.body.includes("name: typescript"));
    assert.ok(a.body.endsWith("\n```"));
    // No `agents` declared → undefined (every spawn receives it).
    assert.equal(a.agents, undefined);
  });

  it("throws CONTEXT_ASSET_NOT_FOUND when a catalog dir is missing", () => {
    assert.throws(
      () => materializeContextAssets(
        bundleWithAssets([{ heading: "Refs catalog", kind: "frontmatter-catalog", dir: "knowledge/missing" }]),
        bundleDir,
      ),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "CONTEXT_ASSET_NOT_FOUND");
        assert.equal((err as KernelError).detail?.["dir"], "knowledge/missing");
        return true;
      },
    );
  });

  it("throws CONTEXT_ASSET_NOT_FOUND when a file asset is missing", () => {
    assert.throws(
      () => materializeContextAssets(
        bundleWithAssets([{ heading: "Registry", kind: "file", path: "nope.yaml" }]),
        bundleDir,
      ),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "CONTEXT_ASSET_NOT_FOUND");
        assert.equal((err as KernelError).detail?.["path"], "nope.yaml");
        return true;
      },
    );
  });

  it("returns [] when the bundle declares no assets", () => {
    assert.deepEqual(materializeContextAssets(makeBundle([]), bundleDir), []);
  });
});

// ============================================================================
// buildPrompt — bundle context assets + active agents in the block
// ============================================================================

describe("buildPrompt — context assets + active agents", () => {
  const refsAsset: RenderedContextAsset = {
    heading: "Refs catalog",
    body: "FILE: knowledge/references/api-design.md\nsummary: API contracts",
    agents: ["classifier"],
  };
  const stackAsset: RenderedContextAsset = {
    heading: "Stack candidate registry",
    body: "```yaml\nlanguages:\n  - name: typescript\n```",
    agents: ["classifier"],
  };

  it("injects an asset into the consuming agent's block, under the bundle heading", () => {
    const out = buildPrompt(
      stateStub(),
      agent("classifier"),
      fullRegistry({
        prompts: new Map([["classifier", { agent: "classifier", body: "# Classifier\n" }]]),
        context_assets: [refsAsset, stackAsset],
      }),
    );
    assert.ok(out.includes("### Refs catalog"));
    assert.ok(out.includes("FILE: knowledge/references/api-design.md"));
    assert.ok(out.includes("### Stack candidate registry"));
    assert.ok(out.includes("name: typescript"));
  });

  it("withholds an agent-scoped asset from a non-matching agent", () => {
    const out = buildPrompt(
      stateStub(),
      agent("implementer"),
      fullRegistry({
        prompts: new Map([["implementer", { agent: "implementer", body: "# Implementer\n" }]]),
        context_assets: [refsAsset, stackAsset],
      }),
    );
    // The bulky catalog/registry stay out of a non-consuming sibling's prompt.
    assert.ok(!out.includes("### Refs catalog"));
    assert.ok(!out.includes("### Stack candidate registry"));
    // The kernel block itself is still present.
    assert.ok(out.includes("## Spawn context"));
  });

  it("includes an un-scoped asset (no `agents`) in every agent's block", () => {
    const shared: RenderedContextAsset = { heading: "Shared notes", body: "be careful" };
    const out = buildPrompt(
      stateStub(),
      agent("implementer"),
      fullRegistry({
        prompts: new Map([["implementer", { agent: "implementer", body: "# Implementer\n" }]]),
        context_assets: [shared],
      }),
    );
    assert.ok(out.includes("### Shared notes\nbe careful"));
  });

  it("lists the flow's active agents (spawn + fanout targets), de-duplicated and sorted", () => {
    const out = buildPrompt(
      stateStub({ flow_name: "default" }),
      agent("classifier"),
      fullRegistry({
        prompts: new Map([["classifier", { agent: "classifier", body: "# Classifier\n" }]]),
        flows: { default: ["s-classify", "s-review", "s-implement"] },
        stages: {
          "s-classify": spawnStage("s-classify", "classifier"),
          "s-review": fanoutStage("s-review", ["logic-reviewer", "security"]),
          "s-implement": spawnStage("s-implement", "implementer"),
        },
      }),
    );
    // Sorted, unique: classifier, implementer, logic-reviewer, security.
    assert.ok(out.includes("### Active agents\nclassifier, implementer, logic-reviewer, security"));
  });

  it("omits the Active agents section when the registry carries no flow", () => {
    const out = buildPrompt(
      stateStub({ flow_name: "default" }),
      agent("classifier"),
      fullRegistry({ prompts: new Map([["classifier", { agent: "classifier", body: "# Classifier\n" }]]) }),
    );
    assert.ok(!out.includes("### Active agents"));
  });

  it("is byte-identical on re-render of the same state + registry (determinism)", () => {
    const reg = fullRegistry({
      prompts: new Map([["classifier", { agent: "classifier", body: "# Classifier\n" }]]),
      context_assets: [refsAsset, stackAsset],
      flows: { default: ["s-classify", "s-review"] },
      stages: {
        "s-classify": spawnStage("s-classify", "classifier"),
        "s-review": fanoutStage("s-review", ["security", "logic-reviewer"]),
      },
    });
    const st = stateStub({ flow_name: "default" });
    assert.equal(
      buildPrompt(st, agent("classifier"), reg),
      buildPrompt(st, agent("classifier"), reg),
    );
  });
});
