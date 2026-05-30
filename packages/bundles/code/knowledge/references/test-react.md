---
tags: [testing, react, nextjs, vitest, jest, frontend]
stack_signals:
  - language: [typescript, javascript]
  - project_type: [frontend-app, monorepo]
summary: |
  React / Next.js testing — Vitest / Jest detection, what to test
  (components with logic, hooks, mutations), Testing Library patterns.
when_to_load: |
  Task writes or changes tests for a React/Next.js codebase, OR review of
  test code in a React/Next.js project. Vitest/Jest config present.
agent_hints: [test, acceptance, logic-reviewer]
---

# Testing: React / Next.js

## Framework Detection
- `vitest.config.*` or `vite.config.* with test` → Vitest
- `jest.config.*` or `package.json "jest"` → Jest
- Neither → check CLAUDE.md stack. React/Next.js → recommend Vitest. NestJS → Jest (built-in).

## What to Test
**Components — only if they contain logic:**
- Conditional rendering
- User interaction → expected outcome
- Do NOT test: pure layout, styling, static content

**Custom hooks:**
- Use `renderHook` from Testing Library
- Test state changes, return values, cleanup

## File Naming
`*.test.ts`, `*.test.tsx`, `*.spec.ts`

## Query Priority (Testing Library)
Prefer in this order:
1. `getByRole` (most accessible)
2. `getByLabelText`
3. `getByText`
4. `getByTestId` (last resort)

## User Interaction
Prefer `userEvent` over `fireEvent` — it simulates real browser behavior:
```typescript
import userEvent from '@testing-library/user-event';
const user = userEvent.setup();
await user.click(button);
await user.type(input, 'text');
```

## Async Patterns
- Use `waitFor` / `findBy*` for async state updates
- Handle act() warnings by using Testing Library's async utilities
- Always `await` user events

## Mocking
- MSW for API mocking (intercepts at network level)
- `vi.mock()` / `jest.mock()` for module mocks
- `renderWithProviders` wrapper for QueryClient + Router + Store
- Mock router: `MemoryRouter` with initial entries

## Do NOT
- Test implementation details (internal state, method calls)
- Test third-party library behavior
- Use snapshot tests unless project already has them
- Hardcode dates or rely on test execution order
