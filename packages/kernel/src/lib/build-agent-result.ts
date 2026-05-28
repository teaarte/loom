// Lift a provider-raw payload + the agent's `output_kind` into a
// fully-typed `AgentResult`. Schema validation is minimal in this
// revision — shape + required-field checks for the four kernel-default
// kinds; the ajv-driven validator that consumes registered JSON
// Schemas lands with the findings-schema work and supersedes the
// inline checks below without changing the call surface.
//
// Lenient parsing: a malformed JSON header surfaces as
// `schema_validation: { ok: false, reason }` on the returned result —
// the caller still persists the row for forensics, so a single bad
// agent never destroys good siblings' work.

import type { AgentResult } from "../types/agent-result.js";
import type { Finding, FindingSeverity, FindingStatus } from "../types/findings.js";
import type { AgentOutputKind } from "../types/plugins.js";

export interface BuildAgentResultArgs {
  agent: string;
  agent_run_id: string;
  output_kind: AgentOutputKind;
  raw_output: string;
  parsed_header?: Record<string, unknown>;
  tokens?: { in: number; out: number; cached?: number };
}

export function buildAgentResult(args: BuildAgentResultArgs): AgentResult {
  const header = args.parsed_header ?? tryParseJsonHeader(args.raw_output);
  const base: AgentResult = {
    agent: args.agent,
    agent_run_id: args.agent_run_id,
    output: args.raw_output,
    schema_validation: { ok: true },
  };
  if (args.tokens !== undefined) base.tokens = args.tokens;

  switch (args.output_kind) {
    case "reviewer":
    case "validator": {
      if (header === null) {
        return {
          ...base,
          schema_validation: {
            ok: false,
            reason: "no-json-fence: agent output does not contain a parseable JSON header",
          },
        };
      }
      const verdictReason = validateVerdictHeader(header);
      if (verdictReason !== null) {
        return { ...base, parsed_header: header, schema_validation: { ok: false, reason: verdictReason } };
      }
      const findingsResult = extractFindings(header, args.agent);
      if (findingsResult.reason !== null) {
        return {
          ...base,
          parsed_header: header,
          schema_validation: { ok: false, reason: findingsResult.reason },
        };
      }
      return { ...base, parsed_header: header, findings: findingsResult.findings };
    }
    case "classifier": {
      if (header === null) {
        return {
          ...base,
          schema_validation: {
            ok: false,
            reason: "no-json-fence: classifier output does not contain a parseable JSON header",
          },
        };
      }
      return { ...base, parsed_header: header };
    }
    case "nonreview":
      return base;
    default:
      // Bundle-extended output_kinds: kernel-default schema set has no
      // opinion; the bundle owns persistence for the kind it introduced.
      // Still attach `parsed_header` if a JSON fence was present so the
      // bundle-side persistor doesn't re-parse.
      if (header !== null) return { ...base, parsed_header: header };
      return base;
  }
}

// Look for a `{...}` JSON object at the top of the output OR within a
// ```json ... ``` fenced block. Returns null if neither parses.
function tryParseJsonHeader(raw: string): Record<string, unknown> | null {
  const fenced = raw.match(/```json\s*\n([\s\S]*?)\n```/);
  if (fenced && fenced[1] !== undefined) {
    const parsed = safeParse(fenced[1]);
    if (parsed !== null) return parsed;
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    const parsed = safeParse(trimmed);
    if (parsed !== null) return parsed;
  }
  return null;
}

function safeParse(input: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(input) as unknown;
    if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
      return obj as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

// Reviewer / validator headers MUST carry a `verdict` plus a
// `findings` array (empty array allowed). Anything else surfaces as
// schema-validation failure.
function validateVerdictHeader(header: Record<string, unknown>): string | null {
  const verdict = header["verdict"];
  if (typeof verdict !== "string" || verdict.length === 0) {
    return "schema: verdict missing or not a string";
  }
  if (!Array.isArray(header["findings"])) {
    return "schema: findings array missing";
  }
  return null;
}

function extractFindings(
  header: Record<string, unknown>,
  agent: string,
): { findings: Finding[]; reason: string | null } {
  const raw = header["findings"];
  if (!Array.isArray(raw)) return { findings: [], reason: null };
  const out: Finding[] = [];
  for (let i = 0; i < raw.length; i++) {
    const candidate = raw[i];
    if (candidate === null || typeof candidate !== "object") {
      return { findings: [], reason: `schema: findings[${i}] is not an object` };
    }
    const f = candidate as Record<string, unknown>;
    const severity = severityField(f);
    if (severity === null) {
      return {
        findings: [],
        reason: `schema: findings[${i}].severity must be blocking|warn|info`,
      };
    }
    out.push({
      schema_version: stringField(f, "schema_version", "1.0"),
      id: stringField(f, "id", ""),
      agent: stringField(f, "agent", agent),
      iteration: numberField(f, "iteration", 0),
      task_id: stringField(f, "task_id", ""),
      file: nullableStringField(f, "file"),
      line_start: nullableNumberField(f, "line_start"),
      line_end: nullableNumberField(f, "line_end"),
      severity,
      category: stringField(f, "category", "uncategorized"),
      proposed_new_category: nullableStringField(f, "proposed_new_category"),
      pattern_id: nullableStringField(f, "pattern_id"),
      summary: stringField(f, "summary", ""),
      evidence_excerpt: nullableStringField(f, "evidence_excerpt"),
      suggested_fix: nullableStringField(f, "suggested_fix"),
      status: statusField(f),
      ref_rule_id: nullableStringField(f, "ref_rule_id"),
    });
  }
  return { findings: out, reason: null };
}

function stringField(
  src: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const v = src[key];
  return typeof v === "string" ? v : fallback;
}

function numberField(
  src: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const v = src[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function nullableStringField(
  src: Record<string, unknown>,
  key: string,
): string | null {
  const v = src[key];
  return typeof v === "string" ? v : null;
}

function nullableNumberField(
  src: Record<string, unknown>,
  key: string,
): number | null {
  const v = src[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const SEVERITY_VALUES = new Set<FindingSeverity>(["blocking", "warn", "info"]);
function severityField(src: Record<string, unknown>): FindingSeverity | null {
  const v = src["severity"];
  if (typeof v === "string" && (SEVERITY_VALUES as Set<string>).has(v)) {
    return v as FindingSeverity;
  }
  return null;
}

const STATUS_VALUES = new Set<FindingStatus>([
  "open",
  "fixed",
  "accepted_by_human",
  "dismissed",
]);
function statusField(src: Record<string, unknown>): FindingStatus {
  const v = src["status"];
  if (typeof v === "string" && (STATUS_VALUES as Set<string>).has(v)) {
    return v as FindingStatus;
  }
  return "open";
}
