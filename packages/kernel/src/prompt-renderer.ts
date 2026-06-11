// Prompt renderer — the single owner of turning an Agent's markdown
// template into the spawn prompt.
//
// The work splits across two times so the FSM tick stays replay-
// deterministic:
//
//   - Load time (`materializeTemplates`): the bundle-loader reads every
//     agent's `template_path` from the bundle source tree exactly once,
//     strips an optional frontmatter block, and stores the result in
//     `Registry.prompts`. This is the only place the renderer touches
//     the filesystem.
//   - Tick time (`buildPrompt`): a pure, synchronous function over
//     (state, agent, registry). It substitutes the context-scoped
//     variables into the materialized body, appends a deterministic
//     `## Spawn context` block (the task, its canonical ids, the project,
//     the decisions taken so far, the flow's active agents, and the
//     bundle's pre-materialized context assets scoped to this agent), and
//     returns the prompt string. No filesystem, no clock
//     — so the spawn interpreter keeps its synchronous shape and the tick
//     stays inside the replay contract.
//
// `system_prompt` is NOT inlined into the rendered body: the spawn
// intent carries it as a separate, provider-cacheable prefix, so
// inlining it here would double it.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { KernelError } from "./state/db.js";
import { OPEN_BLOCKERS_KEY, type OpenBlocker } from "./lib/supersede-findings.js";
import type { Bundle, SpawnContextAsset } from "./types/bundle.js";
import type {
  ContextBudget,
  RenderedContextAsset,
  RenderedTemplate,
} from "./types/extension.js";
import type { Agent } from "./types/plugins.js";
import type { Registry } from "./types/registry.js";
import type { PipelineState } from "./types/state.js";

// ============================================================================
// Load time — read templates off disk, strip frontmatter
// ============================================================================

// Read and materialize every agent template declared by the bundle.
// Resolves each `template_path` relative to the bundle source root. A
// missing file is a load-time refusal (`TEMPLATE_NOT_FOUND`) so the
// operator learns at start, not at first spawn.
export function materializeTemplates(
  bundle: Bundle,
  bundle_source_dir: string,
): Map<string, RenderedTemplate> {
  const prompts = new Map<string, RenderedTemplate>();
  for (const agent of bundle.agents) {
    prompts.set(agent.name, materializeOne(agent, bundle_source_dir));
  }
  return prompts;
}

function materializeOne(agent: Agent, bundleSourceDir: string): RenderedTemplate {
  const resolved = join(bundleSourceDir, agent.template_path);
  let raw: string;
  try {
    raw = readFileSync(resolved, "utf8");
  } catch {
    throw new KernelError({
      code: "TEMPLATE_NOT_FOUND",
      message: `agent '${agent.name}' template not found at '${agent.template_path}'`,
      detail: {
        agent: agent.name,
        template_path: agent.template_path,
        resolved,
      },
    });
  }
  const { frontmatter, body } = splitFrontmatter(raw);
  const template: RenderedTemplate = { agent: agent.name, body };
  if (frontmatter !== null) {
    if (frontmatter.system_prompt !== undefined) {
      template.system_prompt = frontmatter.system_prompt;
    }
    if (frontmatter.context_budget !== undefined) {
      template.context_budget = frontmatter.context_budget;
    }
  }
  return template;
}

interface ParsedFrontmatter {
  system_prompt?: string;
  context_budget?: ContextBudget;
}

// A frontmatter block is a leading `---` line, a block of declarations,
// and a closing `---` line. A file without that exact lead-in is treated
// as a plain body and passes through byte-for-byte (every shipped
// template today is a plain body).
function splitFrontmatter(raw: string): {
  frontmatter: ParsedFrontmatter | null;
  body: string;
} {
  const normalized = raw.replace(/^\uFEFF/, "");
  if (!/^---[ \t]*\r?\n/.test(normalized)) {
    return { frontmatter: null, body: raw };
  }
  const lines = normalized.split(/\r?\n/);
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*$/.test(lines[i] ?? "")) {
      close = i;
      break;
    }
  }
  if (close === -1) {
    // Opening delimiter with no close — not frontmatter; keep the raw
    // body intact rather than swallowing it.
    return { frontmatter: null, body: raw };
  }
  const body = lines.slice(close + 1).join("\n");
  return { frontmatter: parseFrontmatter(lines.slice(1, close)), body };
}

// Minimal declaration reader for the two scalar/nested fields the
// renderer surfaces. Top-level keys are unindented `key: value` lines;
// `context_budget` carries its integer thresholds on the following
// indented lines. Anything else in the block is ignored.
function parseFrontmatter(lines: string[]): ParsedFrontmatter {
  const fm: ParsedFrontmatter = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[i] ?? "");
    if (m === null) continue;
    const key = m[1];
    const value = (m[2] ?? "").trim();
    if (key === "system_prompt" && value.length > 0) {
      fm.system_prompt = stripQuotes(value);
    } else if (key === "context_budget") {
      const budget = readContextBudget(lines, i + 1);
      if (budget !== null) fm.context_budget = budget;
    }
  }
  return fm;
}

function readContextBudget(lines: string[], start: number): ContextBudget | null {
  const budget: ContextBudget = {};
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\S/.test(line)) break; // dedent ends the nested block
    const m = /^[ \t]+([A-Za-z_][\w-]*):[ \t]*(\d+)[ \t]*$/.exec(line);
    if (m === null) continue;
    const n = Number(m[2]);
    if (m[1] === "soft_threshold_tokens") budget.soft_threshold_tokens = n;
    else if (m[1] === "hard_threshold_tokens") budget.hard_threshold_tokens = n;
  }
  if (
    budget.soft_threshold_tokens === undefined &&
    budget.hard_threshold_tokens === undefined
  ) {
    return null;
  }
  return budget;
}

function stripQuotes(s: string): string {
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

// Materialize the bundle's declared spawn-context assets off disk, in
// declaration order. The body is formatted to its final string here so
// the tick-time builder appends it verbatim with no further IO. A missing
// dir/file is a load-time refusal (`CONTEXT_ASSET_NOT_FOUND`), same as a
// missing template — the operator learns at start, not at first spawn.
export function materializeContextAssets(
  bundle: Bundle,
  bundle_source_dir: string,
): RenderedContextAsset[] {
  return (bundle.spawn_context_assets ?? []).map((asset) =>
    materializeAsset(asset, bundle_source_dir),
  );
}

function materializeAsset(
  asset: SpawnContextAsset,
  bundleSourceDir: string,
): RenderedContextAsset {
  const body =
    asset.kind === "frontmatter-catalog"
      ? renderCatalog(asset.dir, bundleSourceDir, asset.heading)
      : renderFileAsset(asset.path, asset.fence, bundleSourceDir, asset.heading);
  const rendered: RenderedContextAsset = { heading: asset.heading, body };
  if (asset.agents !== undefined) rendered.agents = asset.agents;
  return rendered;
}

// A digest of every `*.md` under `dir` (sorted for byte stability): the
// path plus the verbatim frontmatter block. The bodies stay out — the
// consumer picks by filename, then reads the chosen files itself. No YAML
// parse (keeps the kernel zero-dep and domain-blind); the frontmatter text
// passes through untouched.
function renderCatalog(dir: string, bundleSourceDir: string, heading: string): string {
  const resolved = join(bundleSourceDir, dir);
  let entries: string[];
  try {
    entries = readdirSync(resolved);
  } catch {
    throw new KernelError({
      code: "CONTEXT_ASSET_NOT_FOUND",
      message: `spawn-context asset '${heading}' directory not found at '${dir}'`,
      detail: { heading, kind: "frontmatter-catalog", dir, resolved },
    });
  }
  const names = entries.filter((n) => n.endsWith(".md")).sort();
  if (names.length === 0) return "(no entries)";
  const cleanDir = dir.replace(/\/+$/, "");
  const blocks = names.map((name) => {
    const raw = readFileSync(join(resolved, name), "utf8");
    const fm = extractFrontmatterText(raw);
    const path = `${cleanDir}/${name}`;
    return fm === null ? `FILE: ${path}` : `FILE: ${path}\n${fm}`;
  });
  return blocks.join("\n\n");
}

// Inline a single file verbatim in a fenced block (the consumer reads the
// whole file — e.g. a list it must choose from rather than invent).
function renderFileAsset(
  path: string,
  fence: string | undefined,
  bundleSourceDir: string,
  heading: string,
): string {
  const resolved = join(bundleSourceDir, path);
  let raw: string;
  try {
    raw = readFileSync(resolved, "utf8");
  } catch {
    throw new KernelError({
      code: "CONTEXT_ASSET_NOT_FOUND",
      message: `spawn-context asset '${heading}' file not found at '${path}'`,
      detail: { heading, kind: "file", path, resolved },
    });
  }
  return `\`\`\`${fence ?? ""}\n${raw.replace(/\n+$/, "")}\n\`\`\``;
}

// Return the verbatim text between a leading `---`…`---` frontmatter pair,
// or null when the file has no frontmatter (mirrors `splitFrontmatter`'s
// delimiter rules but yields the raw block rather than parsing it).
function extractFrontmatterText(raw: string): string | null {
  const normalized = raw.replace(/^\uFEFF/, "");
  if (!/^---[ \t]*\r?\n/.test(normalized)) return null;
  const lines = normalized.split(/\r?\n/);
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*$/.test(lines[i] ?? "")) {
      close = i;
      break;
    }
  }
  if (close === -1) return null;
  return lines.slice(1, close).join("\n");
}

// ============================================================================
// Tick time — pure render (no IO, no clock)
// ============================================================================

// Render the spawn prompt for `agent`. Pure and synchronous: reads the
// materialized body from the registry and substitutes the context-scoped
// variables. When no materialized template exists for this agent (a
// registry built without a source dir, or an agent absent from the map)
// it falls back to a deterministic stub so the spawn interpreter still
// emits a complete intent.
export function buildPrompt(
  state: PipelineState,
  agent: Agent,
  registry: Registry,
): string {
  const template = registry.prompts?.get(agent.name);
  if (template === undefined) {
    return buildPromptStub(state, agent);
  }
  const body = renderBody(template.body, state);
  return appendSpawnContext(body, state, agent, registry);
}

// Append the kernel-built `## Spawn context` block to a rendered body —
// unless the template authored its own. The guard matches a markdown
// `## Spawn context` HEADING (line start), not a prose mention of the
// string: several templates reference `` `## Spawn context` `` inside a
// list item to tell the agent where to read the task, and that must NOT
// suppress the block the agent is being told to read.
function appendSpawnContext(
  body: string,
  state: PipelineState,
  agent: Agent,
  registry: Registry,
): string {
  if (/^##[ \t]+Spawn context\b/m.test(body)) {
    return body;
  }
  return `${body}\n\n${buildSpawnContext(state, agent, registry)}`;
}

// Assemble the `## Spawn context` block. Pure, synchronous, and byte-stable
// for a given (state, agent, registry): no clock, no Map iteration-order
// dependence (decision keys sorted, active agents sorted). The first
// sections draw from `state` alone (task / ids / project / decisions); the
// remainder draw from the registry — the active-agent roster for this flow
// and the bundle's materialized context assets, scoped to the spawning
// agent. Subheading names match what the agent templates
// are told to read ("Canonical identifiers", "Task description", and the
// bundle-chosen asset headings), so an instruction to "copy the task_id
// from the 'Canonical identifiers' section" resolves to where it lands.
export function buildSpawnContext(
  state: PipelineState,
  agent: Agent,
  registry: Registry,
): string {
  const lines: string[] = [
    "## Spawn context",
    "",
    "### Canonical identifiers",
    `- task_id: ${state.task_id ?? ""}`,
    `- driver_state_id: ${state.driver_state_id}`,
    "",
    "### Task description",
    state.task,
  ];
  if (state.task_short != null) {
    lines.push("", "### Task (short)", state.task_short);
  }
  lines.push("", "### Project", state.project_dir);
  lines.push("", "### Decisions so far", renderDecisions(state.decisions));

  // Open blockers a prior gate rejection left for this run to resolve. The
  // gate snapshots them into the driver scratch before retiring the findings
  // (so a re-entered fixer learns WHAT to fix instead of re-reading a
  // byte-identical prompt); the section is absent on a clean first pass and
  // cleared once a gate approves. Domain-blind: any bundle whose gate rejects
  // gets the hand-off, an empty snapshot renders nothing.
  const blockers = readOpenBlockers(state);
  if (blockers.length > 0) {
    lines.push("", "### Open blockers", renderOpenBlockers(blockers));
  }

  const active = activeAgents(state, registry);
  if (active.length > 0) {
    lines.push("", "### Active agents", active.join(", "));
  }

  for (const asset of registry.context_assets ?? []) {
    if (asset.agents !== undefined && !asset.agents.includes(agent.name)) {
      continue;
    }
    lines.push("", `### ${asset.heading}`, asset.body);
  }
  return lines.join("\n");
}

// The agents this flow can spawn — the spawn/fanout targets of the current
// flow's stages, de-duplicated and sorted (byte-stable). Empty when the
// registry carries no flow/stage maps (a hand-built test registry) so the
// section is simply omitted there.
function activeAgents(state: PipelineState, registry: Registry): string[] {
  const flowName = state.driver?.flow_name;
  if (flowName === undefined) {
    return [];
  }
  const stageNames = registry.flows?.get(flowName);
  if (stageNames === undefined) {
    return [];
  }
  const names = new Set<string>();
  for (const stageName of stageNames) {
    const stage = registry.stages?.get(stageName);
    if (stage === undefined) {
      continue;
    }
    if (stage.kind === "spawn") {
      names.add(stage.agent);
    } else if (stage.kind === "fanout") {
      for (const a of stage.agents) names.add(a);
    }
  }
  return [...names].sort();
}

// Render the decisions map as sorted `- key: value` lines. Keys are
// sorted by UTF-16 code unit (the default Array.sort order — NOT
// `localeCompare`, which is locale-dependent and would break byte
// stability). Non-string values are JSON-encoded so each decision stays
// on one line; strings render verbatim. Empty map → an explicit marker.
function renderDecisions(decisions: Record<string, unknown>): string {
  const keys = Object.keys(decisions).sort();
  if (keys.length === 0) {
    return "(none yet)";
  }
  return keys.map((key) => `- ${key}: ${renderDecisionValue(decisions[key])}`).join("\n");
}

function renderDecisionValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value) ?? "null";
}

// Read the open-blocker snapshot the gate left on the driver scratch. Tolerant
// of a missing driver/scratch (the partial states the pure-render tests build)
// and of a malformed entry — a bad row is skipped rather than aborting the
// render, since this is delivery context, not a gating read.
function readOpenBlockers(state: PipelineState): OpenBlocker[] {
  const raw = state.driver?.scratch?.[OPEN_BLOCKERS_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (b): b is OpenBlocker => b !== null && typeof b === "object" && !Array.isArray(b),
  );
}

// Render each blocker as one line: `- [category] file:line: summary — suggested
// fix: …`. Stable for a given snapshot (the gate captured the rows in id order).
function renderOpenBlockers(blockers: OpenBlocker[]): string {
  return blockers
    .map((b) => {
      const loc =
        b.file != null && b.file.length > 0
          ? `${b.file}${typeof b.line === "number" ? `:${b.line}` : ""}`
          : "(no file)";
      const fix =
        typeof b.suggested_fix === "string" && b.suggested_fix.length > 0
          ? ` — suggested fix: ${b.suggested_fix}`
          : "";
      const category = typeof b.category === "string" && b.category.length > 0 ? b.category : "uncategorized";
      return `- [${category}] ${loc}: ${b.summary ?? ""}${fix}`;
    })
    .join("\n");
}

function renderBody(body: string, state: PipelineState): string {
  // Substitute the context-scoped variables the spawn prompt needs.
  // `split`/`join` keeps the replacement literal (so `$`-sequences in a
  // value are inserted verbatim). Any other `{{…}}` token is left as-is.
  let out = body;
  out = substituteAll(out, "{{task}}", state.task ?? "");
  out = substituteAll(out, "{{project_dir}}", state.project_dir ?? "");
  out = substituteAll(out, "{{task_short}}", state.task_short ?? "");
  return out;
}

function substituteAll(text: string, token: string, value: string): string {
  return text.split(token).join(value);
}

// Deterministic placeholder used when an agent has no materialized
// template. Carries the identifying fields a host needs to recognise the
// spawn; the real instructions arrive once the bundle is loaded with its
// source dir.
function buildPromptStub(state: PipelineState, agent: Agent): string {
  return [
    `agent=${agent.name}`,
    `task_id=${state.task_id ?? ""}`,
    `template=${agent.template_path}`,
  ].join("\n");
}
