---
tags: [testing, strategy, coverage, mocks, flake, integration, tdd]
stack_signals: []
summary: |
  Cross-stack test strategy — pin behavior not implementation; coverage % is
  vanity; flaky tests are worse than no tests. Decisions for what to test,
  how to mock, and when integration > unit.
when_to_load: |
  Plan review and acceptance steps; COMPLEX tasks reviewing test specs; or
  any task where the test surface itself is being designed (TDD bootstrap,
  test refactor, mock-strategy review).
agent_hints: [test, logic-reviewer, acceptance, challenger-reviewer]
---

# Test Strategy — Senior Stance

## When this applies
Cross-stack reference loaded during plan review and at acceptance time. Complements `test-{stack}.md` (framework specifics) with strategy-level decisions: what to test, how to mock, when integration > unit, flake mitigation, test data management. Loaded by Test Agent on COMPLEX tasks and by logic-reviewer when reviewing test specs.

## Default Stance
Tests pin behavior, not implementation. A test that breaks when you refactor (without behavior change) is a bad test. Coverage % is a vanity metric — meaningful coverage is "every behavior an external caller depends on has a test that fails when that behavior breaks". Slow flaky tests are worse than no tests because people start ignoring them.

## Patterns (use these)

### Test pyramid — but adjusted for the stack
- **Unit (many, fast)** — pure functions, business logic in isolation, ~ms per test.
- **Integration (medium, slower)** — service + real DB / real Redis (test container), ~100ms per test. Where most bugs actually hide.
- **E2E (few, slowest)** — full stack, user-facing flow, seconds per test.

Classic 70/20/10 split is heuristic, not law. For data-heavy backend, 50/40/10 with more integration is often right. For UI-heavy frontend, integration tests at the component level (with React Testing Library / Vue Testing Library) replace many "unit" tests.

### Test behavior, not implementation
- BAD: assert internal method calls (`expect(spy).toHaveBeenCalledTimes(3)`) on private helpers.
- GOOD: assert observable outcomes — return values, persisted state, side effects to mocked external systems.
- Refactor freedom: if the behavior is unchanged, the test should pass.

### Mock at boundaries, not inside the boundary
- Mock external systems: HTTP APIs, databases, message queues, file system, time.
- Don't mock things you own — use the real implementation. Mocking your own service layer just tests that mocks call mocks.
- Mock the slowest layer, not every layer.

### Contract tests for service boundaries
For cross-service APIs (especially when teams diverge):
- **Provider** publishes the schema.
- **Consumer** runs tests against a contract derived from the schema (Pact, JSON Schema, OpenAPI).
- A breaking change shows up in CI, not in prod.

### Property-based testing where it pays
For pure functions with constrained input space (parsers, validators, math):
```ts
fc.assert(fc.property(fc.string(), s => parse(format(s)) === s));
```
Generates inputs you'd never think to write. Catches edge cases (empty, unicode, max length) automatically. Use `fast-check` (JS) / `hypothesis` (Python).

### Test data management
- **Factories** > fixtures: `userFactory.build({ role: 'admin' })`. Easy to override one field, rest defaults.
- **Seed deterministically** — same data every run. Use seeded random (`faker.seed(42)`).
- **Per-test isolation** — each test creates its own data, transactions roll back, OR DB is wiped between tests.
- **No shared global state** between tests. Order independence.

### Fixed time
Tests that involve dates/timeouts use a fake clock (`vi.useFakeTimers()` / `freezegun`). Real `Date.now()` in tests = flaky tests near midnight or on DST transitions.

### Snapshot tests — sparingly
- OK for: serialized output of pure functions (JSON shape), small UI component HTML.
- NOT OK for: anything large, anything with non-deterministic content (timestamps, IDs), entire pages.
- A snapshot you don't read when it changes is worse than no test.

### Flake mitigation
A flaky test = a real bug 80% of the time, not "just retry". Investigate before marking flaky.
Common causes:
- Time-based assertions without fake clock.
- Test depending on previous test's state (order dependency).
- Async race not awaited.
- Network call to flaky external (mock it).
- Database not cleaned between tests.

If you must retry: limit to 2 attempts, alert on retry rate >5%.

## Anti-Patterns (DO NOT)

### Testing implementation details
Asserting `private` method called N times, internal state values, exact call order of helpers.
**Why it bites:** refactor breaks tests even when behavior is identical. Tests become chains forcing implementation, not verifying outcomes.
**Rule:** test the public surface. If you need to verify private behavior, test it through public calls.

### Mocking the thing under test
`mockUserService.create.mockReturnValue({...})` and then "testing" `userService.create`. You tested the mock.
**Rule:** never mock the subject under test. Mock its dependencies.

### Mocking everything
Mocked DB, mocked cache, mocked HTTP client, mocked logger, mocked filesystem. You're testing that mocks return what you told them to.
**Rule:** integration tests run against real-ish dependencies (test containers, in-memory DB, msw for HTTP). Unit tests for pure logic only.

### `expect(true).toBe(true)` / always-true tests
Test passes regardless of implementation.
**Rule:** every test should fail when the corresponding behavior breaks. Mutation testing surfaces tests that don't.

### One mega-test per function
```ts
test('user service', async () => {
  // 200 lines testing 15 different behaviors
});
```
**Why it bites:** one assertion fails → can't tell which behavior broke. Debugging means rerunning entire setup.
**Rule:** one behavior per test. Descriptive name reads as a spec: `it('rejects email without @ symbol')`.

### `sleep(100)` for "letting things settle"
**Why it bites:** flaky on slow CI; wasteful on fast CI; doesn't actually verify the thing finished.
**Rule:** await the actual condition (`waitFor(() => ...)`, queue.drain, mock-clock advance).

### Snapshot tests of huge HTML / JSON blobs
Diff is unreadable; people approve without reading.
**Rule:** only snapshot small specific outputs. For large output, write targeted assertions.

### Tests that depend on prod data shape
Pulling from prod DB at test time, asserting "user 42 exists".
**Rule:** seeded test data. Tests are reproducible offline.

### Coverage as a goal
"We need 80% coverage." Team writes tests that touch lines without verifying behavior.
**Rule:** coverage is a diagnostic, not a goal. 60% coverage with high-quality behavior tests > 95% coverage with implementation-detail tests.

### Skipped/disabled tests with no plan to fix
`test.skip`, `xit`, commented-out tests.
**Rule:** delete or fix. Skipped tests rot, lose their ability to catch the bug they were meant to catch.

### Generated tests as substitute for thought
"Cursor wrote 50 tests for this function." 49 of them test the same happy path with slight variations. None test the edge case that actually matters.
**Rule:** review every test for unique behavioral value before merging.

## Decision Framework

| Question | Answer |
|---|---|
| Pure function with bounded input? | Property-based test |
| Service with DB, mocked DB? | Integration test with real test container |
| External HTTP API? | Mock with msw / VCR / contract test |
| Cross-service contract? | Pact or schema-based contract test |
| User-facing flow? | E2E test for critical paths only |
| Time-dependent code? | Fake clock; never real `Date.now()` |
| Data parsing? | Property-based + edge-case suite |
| Race condition? | Test concurrent invocations explicitly |
| Setup-heavy code? | Factory pattern with sensible defaults |
| Long-running async? | `waitFor` not `sleep`; advance fake timers |

## Cost Model

| Test type | Speed (typical) | Where most bugs found |
|---|---|---|
| Pure unit | < 5ms | Edge cases in algorithms, validation |
| Integration (test container) | 50-500ms | Service contract bugs, query bugs, transaction issues |
| E2E (real browser) | 2-30s | UX flow regressions, integration glue |
| Property-based | varies by N | Inputs you didn't think of |

| Anti-pattern | Cost |
|---|---|
| Mocked-everything unit tests | False confidence; bugs ship in integration paths |
| Flaky tests retried | CI time wasted; team loses trust in suite |
| Coverage-driven testing | Velocity drops; tests don't catch real bugs |
| One mega-test | Debug time 10x when it fails |

## Red Flags in Diff

- New unit test that mocks the function being tested → flag (testing the mock).
- New test asserting `private` method calls or internal state → flag (implementation-detail testing).
- New `sleep`/`setTimeout` in test code without a real reason → flag (flake risk).
- New `test.skip` / `xit` / `it.todo` without a tracking issue → flag (rot risk).
- New snapshot test on output > 100 lines → flag (will be approved without reading).
- New test using real `Date.now()` / `new Date()` for time-sensitive assertions → flag (use fake clock).
- New mock for a service the test claims to integration-test → flag (it's now a unit test in disguise).
- Test setup that copies data from prod / depends on existing data → flag (use factories).
- Test asserting `toHaveBeenCalledTimes` on a mock 5+ times in a single test → flag (testing the mock orchestration).
- New external HTTP call in a unit test (no mock) → flag (network in unit suite).
- New test without arrange/act/assert structure (one giant block) → flag.
