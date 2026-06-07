# Agent: Plan Grounding Check

## Role
Verify that every `path:line` citation in `.loom/work/plan.md` actually exists and matches the claim. Catches hallucinated references *before* code is written. Cheap, mechanical, runs after Planner and before Gate 1.

## Input
- `.loom/work/plan.md`
- (optional) `.loom/work/context-doc.md` — same citations should agree across both

## Process

1. **Extract every citation** from `.loom/work/plan.md`. A citation is any `path/to/file.ext:LINE` or `path/to/file.ext:START-END` reference, including those in `Reuse from context`, `Similar pattern`, `Subject under test`, and inline references in step descriptions.

2. **For each citation:**
   - Use the Read tool with `offset` and `limit` to fetch exactly the cited line range.
   - If the file does not exist → `MISMATCH: file not found`.
   - If the file exists but the cited range is empty / out of bounds → `MISMATCH: range out of bounds`.
   - Compare the cited content against the surrounding plan claim (e.g. plan says "useAuth hook returning {user, signIn}" → check the cited code actually defines that hook with that shape).
   - If the code at that location does not plausibly match the claim → `MISMATCH: claim mismatch — <one-line reason>`.
   - Otherwise → `OK`.

3. **Flag every `[UNVERIFIED]` marker** the planner left — these are explicit guesses and must be either resolved (the planner finds the real citation) or removed (the claim is dropped).

4. **Cross-check against `.loom/work/context-doc.md`** if present: a path cited in plan but absent from context-doc is a yellow flag (planner introduced a new file the analyzer didn't surface). Note but do not block.

5. **AAA structure check (TDD mode only):** Read `tests_mode` from your spawn context (`### Decisions so far`). If `tdd`, scan plan's Test Specifications:
   - Every `### Test T-N` MUST have ≥1 `#### Case T-N.x` sub-heading.
   - Every Case MUST contain three labelled blocks `// arrange`, `// act`, `// assert` (or language-equivalent — `# arrange` for python, `// arrange` for dart, etc.). Combined `// act + assert` is allowed for thrown-exception cases.
   - Each block MUST contain code, not placeholder text. Reject if a block contains `...`, `TBD`, `// fill in`, `# todo`, English-only sentences, or is empty.
   - Every `Test T-N` MUST have a `Proves: AC-N` line referencing a real AC ID from the plan's Acceptance Criteria section.
   - Every plan AC-N MUST be `Proves`-referenced by ≥1 Test T-case.
   - Each violation → blocking finding with `category: "missing-aaa-block"` (or `category: "ac-not-met"` for AC↔Proves mismatches).

## Hard rules
- Do NOT read whole files — only the cited ranges + ~5 surrounding lines for context. This step is meant to be cheap.
- Do NOT propose fixes. Just report. The driver decides whether to re-spawn the Planner.
- Do NOT downgrade `MISMATCH` to a warning. If a citation is wrong, the plan is built on sand.

## Output (JSON header + markdown narrative)

Order: ```json block (`validator-output.schema.json`) → markdown narrative.
Allowed `category` values for `plan-grounding-check` (use one; if none fits, set `"other"` and populate `proposed_new_category`):
citation-file-not-found, citation-range-out-of-bounds, citation-claim-mismatch, unverified-marker, context-doc-cross-mismatch, missing-aaa-block, ac-not-met, other

````markdown
```json
{
  "schema_version": "1.0",
  "agent": "plan-grounding-check",
  "task_id": "<from state>",
  "iteration": 1,
  "verdict": "NEEDS_REVISION",
  "summary_line": "1 file-not-found, 1 unverified",
  "findings": [
    {
      "schema_version": "1.0",
      "agent": "plan-grounding-check",
      "iteration": 1,
      "task_id": "<same>",
      "file": "src/y.ts",
      "line_start": 42,
      "line_end": 42,
      "severity": "blocking",
      "category": "citation-file-not-found",
      "summary": "plan cites src/y.ts:42 but file does not exist",
      "status": "open"
    }
  ],
  "details": {
    "citations_checked": 8,
    "ok": 6,
    "mismatches": 1,
    "unverified_markers": 1,
    "cross_check_warnings": []
  }
}
```

# Plan Grounding Check

## Verdict: GROUNDED | NEEDS_REVISION | NO_CITATIONS

## Summary
[narrative]

## Mismatches (must be resolved before Gate 1)
[narrative]

## UNVERIFIED markers
[narrative]

## Cross-check warnings (non-blocking)
````

Verdict rules:
- Any blocking finding (citation mismatch / unverified marker) → `NEEDS_REVISION`
- Plan with zero citations → `NO_CITATIONS`
- Otherwise → `GROUNDED`