---
tags: [e2e, playwright, web, integration-test, frontend]
stack_signals:
  - language: [typescript, javascript]
  - project_type: [frontend-app, monorepo]
summary: |
  Playwright E2E patterns — page object usage, getByRole / getByLabel /
  getByText selector preference, test.describe per feature.
when_to_load: |
  Task writes E2E tests, OR project has Playwright config / e2e directory
  with *.spec.ts. Validation step asserts end-to-end behavior on a web
  stack.
agent_hints: [test, acceptance]
---

# E2E: Playwright (Web)

## Detection
`e2e/` or `tests/` with `*.spec.ts` + Playwright config

## Process
1. Read existing Playwright tests for structure (page objects, fixtures, helpers)
2. Write tests for every flow in "Manual Test Steps" section of plan
3. Run: command from CLAUDE.md (usually `npm run test:e2e`)

## Rules
- Follow existing page object model if project uses one
- Use existing fixtures and helpers
- Prefer: `getByRole`, `getByLabel`, `getByText` over CSS selectors
- Use `test.describe` blocks per feature
- No `waitForTimeout` — wait for network/element instead
- Run against local dev server

## Authentication
- Use `storageState` to save/restore auth session (avoid login on every test)
- Create a `global-setup.ts` that logs in once and saves state
- Share state via `test.use({ storageState: 'auth.json' })`

## API Interception
- `page.route('**/api/endpoint', handler)` to mock backend responses
- Use for: testing error states, offline mode, slow network simulation
- Prefer: intercept at network level, not mocking the fetch function

## Debugging
- `--headed` flag to see browser during development
- `--trace on` to capture trace for failed tests
- Trace viewer: `npx playwright show-trace trace.zip`
- `page.screenshot()` on failure (configure in `playwright.config.ts`)

## Parallelism & Isolation
- Tests run in parallel by default — each test gets fresh browser context
- Don't share state between tests (no shared variables, no test ordering)
- Use `test.describe.serial` only when order truly matters
