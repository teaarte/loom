// Lift a provider-raw payload + the agent's `output_kind` into a
// fully-typed `AgentResult`. Schema validation is shape + required-field
// checks for the kernel-default kinds; the ajv-driven validator that
// consumes registered JSON Schemas lands with the findings-schema work
// and supersedes the inline checks below without changing the call surface.
//
// Two design properties this revision is built around:
//
//   1. TOLERANT ingestion. An agent's JSON header is accepted whether it
//      arrives in a ```json fence (any language tag, indentation, or blank
//      lines around it), as a bare top-level object, or as a balanced
//      `{…}` embedded in surrounding prose. The header is the
//      machine-parseable surface; we do not also dictate the exact
//      whitespace it is wrapped in. (A strict fence regex previously
//      rejected schema-valid output that an agent merely formatted
//      differently.)
//
//   2. SCHEMA-AWARE + DIAGNOSABLE rejection. Validation branches on
//      `output_kind`: reviewers MUST carry a `findings` array; validators
//      legitimately omit it (their schema makes it optional). A rejection
//      surfaces a machine-readable `detail` — which kind of failure, which
//      field, expected-vs-got, and a bounded excerpt — so a caller can
//      correct and re-deliver instead of guessing. `reason` stays the
//      human one-liner every prior reader consumed.
//
// Lenient parsing: a malformed JSON header surfaces as
// `schema_validation: { ok: false, reason, detail }` on the returned
// result — the caller still persists the row for forensics, so a single
// bad agent never destroys good siblings' work.

import type { AgentResult, SchemaValidationDetail } from "../types/agent-result.js";
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
  const parse: HeaderParse =
    args.parsed_header !== undefined
      ? { ok: true, header: args.parsed_header }
      : tryParseJsonHeader(args.raw_output);
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
      if (parse.ok === false) {
        return {
          ...base,
          schema_validation: parseFailure(parse, args.output_kind, args.raw_output),
        };
      }
      const reviewKind: "reviewer" | "validator" =
        args.output_kind === "reviewer" ? "reviewer" : "validator";
      const verdictDetail = validateVerdictHeader(parse.header, reviewKind);
      if (verdictDetail !== null) {
        return {
          ...base,
          parsed_header: parse.header,
          schema_validation: schemaFieldFailure(verdictDetail),
        };
      }
      const findingsResult = extractFindings(parse.header, args.agent);
      if (findingsResult.detail !== null) {
        return {
          ...base,
          parsed_header: parse.header,
          schema_validation: schemaFieldFailure(findingsResult.detail),
        };
      }
      return { ...base, parsed_header: parse.header, findings: findingsResult.findings };
    }
    case "classifier": {
      if (parse.ok === false) {
        return {
          ...base,
          schema_validation: parseFailure(parse, args.output_kind, args.raw_output),
        };
      }
      return { ...base, parsed_header: parse.header };
    }
    case "nonreview":
      return base;
    default:
      // Bundle-extended output_kinds: kernel-default schema set has no
      // opinion; the bundle owns persistence for the kind it introduced.
      // Still attach `parsed_header` if a JSON object was present so the
      // bundle-side persistor doesn't re-parse.
      if (parse.ok === true) return { ...base, parsed_header: parse.header };
      return base;
  }
}

// ============================================================================
// Tolerant JSON-header extraction
// ============================================================================

type HeaderParse =
  | { ok: true; header: Record<string, unknown> }
  | { ok: false; kind: "no-json" }
  | { ok: false; kind: "json-parse"; excerpt: string };

// Try every plausible JSON-object candidate in priority order — a fenced
// block first (the documented convention), then the whole output if it is
// itself an object, then any balanced `{…}` embedded in prose. The first
// candidate that parses to an object wins. Distinguishes "a block was
// present but unparseable" (`json-parse`) from "nothing JSON-shaped at all"
// (`no-json`) so the caller can report the real cause.
function tryParseJsonHeader(raw: string): HeaderParse {
  const candidates = collectJsonCandidates(raw);
  for (const candidate of candidates) {
    const parsed = safeParse(candidate);
    if (parsed !== null) return { ok: true, header: parsed };
  }
  if (candidates.length > 0) {
    return { ok: false, kind: "json-parse", excerpt: clip(candidates[0] ?? raw) };
  }
  return { ok: false, kind: "no-json" };
}

// Candidate JSON-object strings, most-explicit first. Order matters: a
// fenced block is the agent's declared header, so it is tried before a
// looser balanced-brace scan that could pick up an unrelated `{…}`.
function collectJsonCandidates(raw: string): string[] {
  const out: string[] = [];

  // 1. Fenced code blocks — tolerant of the language tag (```json, ```JSON,
  //    or none), indentation, and blank lines around the content. We trim
  //    the captured inner text before parsing, so trailing whitespace or a
  //    final newline before the closing fence no longer matters.
  const fenceRe = /```[^\n`]*\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(raw)) !== null) {
    const inner = m[1];
    if (inner !== undefined) {
      const trimmed = inner.trim();
      if (trimmed.startsWith("{")) out.push(trimmed);
    }
  }

  // 2. The whole output, when it is itself a JSON object.
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) out.push(trimmed);

  // 3. Balanced `{…}` regions anywhere in the output — catches a header an
  //    agent emitted inline (no fence) or wrapped in a fence shape the
  //    regex above did not recognize.
  for (const region of balancedObjects(raw)) out.push(region);

  return out;
}

// Scan for top-level balanced `{…}` substrings, respecting string literals
// and escapes so a brace inside a quoted value never throws off the depth
// count. Bounded to a handful of regions — a header is near the top, and an
// unbounded scan over a huge prose body buys nothing.
function balancedObjects(raw: string, max = 5): string[] {
  const out: string[] = [];
  const n = raw.length;
  let i = 0;
  while (i < n && out.length < max) {
    if (raw[i] !== "{") {
      i += 1;
      continue;
    }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let j = i;
    for (; j < n; j += 1) {
      const ch = raw[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') {
        inStr = true;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          j += 1;
          break;
        }
      }
    }
    if (depth === 0 && j > i) {
      out.push(raw.slice(i, j));
      i = j;
    } else {
      // Unbalanced from here to EOF — no complete object remains.
      break;
    }
  }
  return out;
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

// ============================================================================
// Schema-aware header validation
// ============================================================================

// Reviewer / validator headers MUST carry a non-empty `verdict`. A
// reviewer MUST also carry a `findings` array (its schema requires it); a
// validator MAY omit `findings` (its schema makes it optional) but, when
// present, it must be an array. Returns a structured detail on failure,
// null on success.
function validateVerdictHeader(
  header: Record<string, unknown>,
  kind: "reviewer" | "validator",
): SchemaValidationDetail | null {
  const verdict = header["verdict"];
  if (typeof verdict !== "string" || verdict.length === 0) {
    return {
      kind: "schema-field",
      field: "verdict",
      expected: "a non-empty string",
      got: describe(verdict),
    };
  }
  const findings = header["findings"];
  if (kind === "reviewer") {
    if (!Array.isArray(findings)) {
      return {
        kind: "schema-field",
        field: "findings",
        expected: "an array",
        got: describe(findings),
      };
    }
  } else if (findings !== undefined && !Array.isArray(findings)) {
    // Validator: findings is optional, but an ill-typed one is still wrong.
    return {
      kind: "schema-field",
      field: "findings",
      expected: "an array when present (optional for validators)",
      got: describe(findings),
    };
  }
  return null;
}

function extractFindings(
  header: Record<string, unknown>,
  agent: string,
): { findings: Finding[]; detail: SchemaValidationDetail | null } {
  const raw = header["findings"];
  if (!Array.isArray(raw)) return { findings: [], detail: null };
  const out: Finding[] = [];
  for (let i = 0; i < raw.length; i++) {
    const candidate = raw[i];
    if (candidate === null || typeof candidate !== "object") {
      return {
        findings: [],
        detail: {
          kind: "schema-field",
          field: `findings[${i}]`,
          expected: "an object",
          got: describe(candidate),
        },
      };
    }
    const f = candidate as Record<string, unknown>;
    const severity = severityField(f);
    if (severity === null) {
      return {
        findings: [],
        detail: {
          kind: "schema-field",
          field: `findings[${i}].severity`,
          expected: "blocking|warn|info (or a known synonym, e.g. high/medium/low)",
          got: describe(f["severity"]),
        },
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
  return { findings: out, detail: null };
}

// ============================================================================
// Failure → schema_validation envelope
// ============================================================================

const EXCERPT_MAX = 400;

// Bounded slice of raw output for forensics — never the whole blob.
function clip(raw: string): string {
  const t = raw.trim();
  return t.length <= EXCERPT_MAX ? t : `${t.slice(0, EXCERPT_MAX)}…`;
}

function describe(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function parseFailure(
  parse: { ok: false; kind: "no-json" } | { ok: false; kind: "json-parse"; excerpt: string },
  kind: AgentOutputKind,
  raw: string,
): { ok: false; reason: string; detail: SchemaValidationDetail } {
  if (parse.kind === "no-json") {
    return {
      ok: false,
      reason: `no-json: ${kind} output contained no parseable JSON object`,
      detail: { kind: "no-json", excerpt: clip(raw) },
    };
  }
  return {
    ok: false,
    reason: `json-parse: a JSON block was found in ${kind} output but did not parse`,
    detail: { kind: "json-parse", excerpt: parse.excerpt },
  };
}

function schemaFieldFailure(
  detail: SchemaValidationDetail,
): { ok: false; reason: string; detail: SchemaValidationDetail } {
  const field = detail.field !== undefined ? ` ${detail.field}` : "";
  const expected = detail.expected !== undefined ? ` expected ${detail.expected}` : "";
  const got = detail.got !== undefined ? `, got ${detail.got}` : "";
  return { ok: false, reason: `schema:${field}${expected}${got}`, detail };
}

// ============================================================================
// Field coercion
// ============================================================================

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

// Accept the canonical {blocking,warn,info} plus the common synonyms agents
// reach for (high/medium/low, critical/major/minor, warning/note/nit, …) so
// a schema-valid finding is not rejected over a vocabulary mismatch. Maps
// case-insensitively; an unknown token still returns null (a genuine schema
// failure, not a synonym we silently swallow).
const SEVERITY_SYNONYMS = new Map<string, FindingSeverity>([
  ["blocking", "blocking"],
  ["blocker", "blocking"],
  ["block", "blocking"],
  ["critical", "blocking"],
  ["high", "blocking"],
  ["error", "blocking"],
  ["fatal", "blocking"],
  ["severe", "blocking"],
  ["warn", "warn"],
  ["warning", "warn"],
  ["medium", "warn"],
  ["moderate", "warn"],
  ["major", "warn"],
  ["info", "info"],
  ["informational", "info"],
  ["low", "info"],
  ["minor", "info"],
  ["note", "info"],
  ["nit", "info"],
  ["suggestion", "info"],
  ["trivial", "info"],
]);

function severityField(src: Record<string, unknown>): FindingSeverity | null {
  const v = src["severity"];
  if (typeof v !== "string") return null;
  return SEVERITY_SYNONYMS.get(v.trim().toLowerCase()) ?? null;
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
