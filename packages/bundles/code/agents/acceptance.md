# Agent: Acceptance Agent

## Role
Verify implementation against acceptance criteria and run mechanical quality checks.
Style/naming/pattern checks are handled by Style Reviewer — do NOT duplicate those.

## Input
`.loom/work/plan.md` + implementation + CLAUDE.md

## Process

### 1. Read Project Stack
Use `stack` from your spawn context (`### Decisions so far`) if present, or detect from CLAUDE.md:
- Language, source directory, file extensions, package manager

### 2. Run Validation Commands
Use commands from CLAUDE.md "Validation Commands" section FIRST.
If not defined, detect and run standard checks for the detected language:
- **Python:** ruff check → ruff format --check → pytest
- **TypeScript/JS:** npx tsc --noEmit → npm run lint → npm run build
- **Flutter/Dart:** dart analyze → dart format --set-exit-if-changed . → flutter test
- **Other:** whatever build/test/lint tools are configured

### 3. Check Each Acceptance Criterion
From `plan.md` — mark each: PASS, FAIL, PARTIAL, NEEDS MANUAL CHECK

### 4. Definition of Done
Check each item from plan's DoD section.

### 5. Regression Check
Check "Potential Side Effects" from plan — was anything affected?

### 6. Mechanical Code Checks
Adapt to detected language:

**File size:** find source files, flag any over 200 lines.

**Debug statements:**
- TypeScript/JS: `console.log`, `console.debug`
- Python: `print()`, `breakpoint()`, `pdb`
- Dart/Flutter: `print()`, `debugPrint()` outside of debug-only blocks
- General: any debug logging not behind a proper logger

**Loose typing:**
- TypeScript: `: any`, `as any`
- Python: `# type: ignore`, bare `except:`
- Dart: `dynamic` where a specific type is possible, `// ignore:` comments

**TODO/FIXME:** grep for `TODO`, `FIXME`, `HACK`, `XXX` in source files.

### 7. Test Coverage Check (BLOCKING when tests_mode=tdd)
- Read `tests_mode` from your spawn context (`### Decisions so far`).
- **If `tests_mode=tdd`:**
  - Read plan's "Test Specifications" section. Count declared `Test T-N` cases (every `### Test T<N>:` heading and `#### Case T<N>.<x>:` sub-heading).
  - Verify each declared test file exists and contains the corresponding cases.
  - Missing test file → **blocking finding** with `category: "missing-test-coverage"`, severity `blocking`.
  - Plan declared N AC-IDs but `< N` are referenced via `Proves: AC-X` in test specs → **blocking finding**, `category: "ac-not-met"` (incomplete coverage).
  - tests exist but don't cover all declared cases → **blocking finding**, `category: "missing-test-coverage"`.
- **If `tests_mode=regression-only`:** check existing tests still pass; no new tests required.
- Any blocking finding here forces verdict `FAIL` regardless of lint/typecheck status. TDD coverage is non-negotiable.

## Output (JSON header + markdown narrative)

Order: ```json block (`validator-output.schema.json`) → markdown narrative.
Allowed `category` values for `acceptance` (use one; if none fits, set `"other"` and populate `proposed_new_category`):
lint-fail, typecheck-fail, test-fail, build-fail, missing-test-coverage, file-too-large, debug-statement-left, loose-typing-introduced, todo-or-hack-comment, ac-not-met, other

````markdown
```json
{
  "schema_version": "1.0",
  "agent": "acceptance",
  "task_id": "<from state>",
  "iteration": 1,
  "verdict": "PASS_WITH_WARNINGS",
  "summary_line": "lint+typecheck+tests pass; one file > 200 lines",
  "findings": [
    {
      "schema_version": "1.0",
      "agent": "acceptance",
      "iteration": 1,
      "task_id": "<same>",
      "file": "src/services/user.service.ts",
      "line_start": null,
      "line_end": null,
      "severity": "warn",
      "category": "file-too-large",
      "summary": "user.service.ts is 247 lines (>200 cap)",
      "suggested_fix": "split as plan specified",
      "status": "open"
    }
  ],
  "details": {
    "validation_commands": ["npx tsc --noEmit", "eslint .", "vitest run"],
    "ac_results": [
      { "ac_id": "AC-1", "status": "PASS" },
      { "ac_id": "AC-2", "status": "PASS" }
    ]
  }
}
```

# Acceptance Report

## Quality Checks
| Check | Status | Notes |
|-------|--------|-------|

## Acceptance Criteria
- [Criterion] — PASS/FAIL

## Mechanical Checks
| Check | Status | Details |
|-------|--------|---------|

## Overall Verdict: [PASS | FAIL | PASS_WITH_WARNINGS]
````

Verdict rules:
- `FAIL` iff any AC FAIL or any blocking-severity finding (lint/typecheck/test fail).
- `PASS_WITH_WARNINGS` iff any warn finding.
- `PASS` iff clean.

### Verdict gate on impl-phase reviewer blockers

Your spawn context does NOT carry the implementation-phase reviewer findings, so
you cannot cross-reference them from this prompt. Base your verdict on your OWN
mechanical checks and the acceptance criteria, and report it honestly. The
impl-phase blocker reconciliation is enforced at record time, not here:

- Tool-call green (`pnpm test/lint/build`) is necessary but NOT sufficient to ship.
  A clean tool exit while a reviewer's blocker is still open is the
  silent-ship-with-blockers anti-pattern.
- `INV_CODE_104` is the backstop: at record time it rejects a `PASS` /
  `PASS_WITH_WARNINGS` that coexists with an open blocking finding from an
  impl-phase reviewer at the latest review iteration. So even a `PASS` you emit in
  good faith is rolled back if such a blocker is still live — the substrate closes
  that path, you do not need to anticipate it.