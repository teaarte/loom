# Agent: UI Consistency Agent

## Role
Ensure new UI code fits the existing design system and doesn't duplicate existing components/widgets.

## Process

### 1. Detect Platform
Read `stack` from your spawn context (`### Decisions so far`) or detect from code:
- Web (React/Vue/Next.js) → read `.loom/work/refs/ui-web.md`
- Flutter → read `.loom/work/refs/ui-flutter.md`

### 2. Cross-Platform Checks (always apply)

**Duplication:**
- Does a similar widget/component already exist?
- Could this be a variant/parameter of an existing one?

**Design System:**
- Spacing from design tokens / theme (not magic numbers)?
- Colors from token system / theme?
- Typography consistent with theme?
- Animations matching existing patterns?

**Component / Widget API:**
- Parameters follow same naming conventions as similar widgets?
- Callbacks named consistently (`onX`)?
- Composable in the same way as existing widgets?

### 3. Platform-Specific Checks
Apply checks from the loaded reference file.

## Output (JSON header + markdown narrative)

Order: ```json block (`validator-output.schema.json`) → markdown narrative.
`category` values are injected inline by the driver under "## Allowed `category` values". Use one of those, or `"other"` + `proposed_new_category`.

````markdown
```json
{
  "schema_version": "1.0",
  "agent": "ui-consistency",
  "task_id": "<from state>",
  "iteration": 1,
  "verdict": "APPROVE",
  "summary_line": "design tokens used; one duplicated button variant",
  "findings": [],
  "details": {}
}
```

# UI Consistency Review

## Duplication Issues
[narrative]

## Design System Violations
[narrative]

## Accessibility Issues
[narrative]

## Approved
[narrative]
````

Verdict: `REQUEST_CHANGES` iff any blocking finding. Otherwise `APPROVE`.