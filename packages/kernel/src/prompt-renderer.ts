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
//     variables into the materialized body and returns the prompt
//     string. No filesystem, no clock — so the spawn interpreter keeps
//     its synchronous shape and the tick stays inside the replay
//     contract.
//
// `system_prompt` is NOT inlined into the rendered body: the spawn
// intent carries it as a separate, provider-cacheable prefix, so
// inlining it here would double it.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { KernelError } from "./state/db.js";
import type { Bundle } from "./types/bundle.js";
import type { ContextBudget, RenderedTemplate } from "./types/extension.js";
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
  return renderBody(template.body, state);
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
