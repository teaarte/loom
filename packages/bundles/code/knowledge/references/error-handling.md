---
tags: [error-handling, retry, fallback, circuit-breaker, exception, resilience]
stack_signals: []
summary: |
  Error-handling design — errors are first-class, fail-fast over
  swallow-and-continue. Patterns for retry, fallback, circuit breakers,
  error envelopes, and dead-letter queues.
when_to_load: |
  Task touches try/catch blocks, error responses, retry logic, circuit
  breakers, fallback paths, error envelopes, exception types, error logging,
  or dead-letter queues. Diff including new external calls, new HTTP
  handlers, new background jobs, or any change to error-handling code also
  qualifies.
agent_hints: [logic-reviewer, challenger-reviewer, security]
---

# Error Handling — Senior Stance

## When this applies
Load when task touches: try/catch blocks, error responses, retry logic, circuit breakers, fallback paths, error envelopes, exception types, error logging, dead-letter queues. Reviewer auto-loads when diff includes new external calls, new HTTP handlers, new background jobs, or any change to error-handling code.

## Default Stance
Errors are first-class. Every external call can fail; every input can be malformed; every assumption can be violated. The question is never "what if it fails?" — it's "how does it fail, and what's the right user-facing outcome?". Default to fail-fast and surface (with proper logging) over swallow-and-continue. Resilience comes from explicit policy (retry, fallback, degrade), not from defensive `try/catch` everywhere.

## Patterns (use these)

### Error categorization (decide once, route consistently)
- **Validation** (4xx) — caller's fault, no retry, surface to user. Don't log as error (noise).
- **Authentication / authorization** (401/403) — caller's fault, no retry.
- **Not found** (404) — caller's fault OR auth-by-existence; never expose internal.
- **Conflict** (409) — caller's fault (idempotency-key conflict, optimistic-lock fail). May retry with new key.
- **Rate limit** (429) — caller's fault, retry with backoff after `Retry-After`.
- **Transient downstream** (502/503/504) — not caller's fault, retry with backoff.
- **Internal error** (500) — server's fault, alert, do NOT retry blindly (might be deterministic bug).

### Retry policy (per category)
- Idempotent + transient (5xx, timeout, connection-reset): exponential backoff + jitter, cap 3-5 attempts.
- Non-idempotent: retry only with idempotency key. Otherwise — fail-fast.
- 4xx (caller's fault): never retry.
- 429: respect `Retry-After`. If header missing, default backoff.

### Circuit breaker
Wrap each external dependency:
- **Closed** (normal): pass through.
- **Open** (when error rate > threshold over window): fail-fast for N seconds.
- **Half-open**: let one request through; success → close.
- Saves the downstream from your retry storm during its outage.

### Fallback path
For non-critical features, define a "degraded" answer:
- Recommendation engine times out → return popular items.
- Personalization service down → return generic content.
- Cache miss + DB slow → serve stale cache.
Document the fallback in code AND in the dashboard so operators see "we're degraded, not broken".

### Error envelope (consistent shape)
For HTTP:
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Email is required",
    "details": [{ "field": "email", "rule": "required" }],
    "request_id": "req_abc123"
  }
}
```
Same shape for every error. Frontend has one error parser, one error UI.

### Typed errors
Distinguish error categories at the type level:
- TS: `class ValidationError extends Error`, `class NotFoundError extends Error`, etc.
- Python: `class ValidationError(BaseException)` hierarchy.
- Rust/Go: `Result<T, E>` with enum E.

Handlers can `instanceof` / pattern-match to decide the right HTTP status and log level.

### Fail-fast on unknown state
If state is corrupt/inconsistent, crash the request (or process) loudly rather than continue with bad data. A loud failure is debuggable; a silently propagating bug is not.

### Dead-letter queue (DLQ)
For background jobs, after retry exhaustion → push to DLQ. Don't drop. Don't loop forever.
- DLQ size monitored; alert when non-zero growth rate.
- Operator can inspect, fix, replay.

### Error context preservation
When wrapping/rethrowing:
- TS: `throw new Error('parse failed', { cause: originalError })` — keeps stack chain.
- Python: `raise NewError(...) from original` — same.
- Don't bury the original. Log the chain when surfacing.

### Timeouts as deliberate errors
Every external call has a timeout. Timeout fires → that's a normal error path, not a panic. Handle it: retry (if eligible), fallback, return 503 to caller.

## Anti-Patterns (DO NOT)

### Empty catch blocks
```ts
try { await externalCall(); } catch (e) {}
```
**Why it bites:** error swallowed, no log, no metric. Bug invisible until prod incident.
**Rule:** every catch logs OR rethrows OR has explicit "ignore-because-X" comment with reasoning.

### Catch-all at the top of every function
```ts
async function handleRequest() {
  try {
    // entire body
  } catch (e) {
    return { error: 'something went wrong' };
  }
}
```
**Why it bites:** loses error categorization, no proper status code, no useful logs. Caller can't tell validation error from infrastructure failure.
**Rule:** centralized error middleware/handler that maps typed errors → HTTP responses. Inner code throws specific error types; top-level translates.

### Logging "error" for every catch including expected ones
Validation failure logs at ERROR level; oncall paged; turns out it's user typo.
**Rule:** ERROR for unexpected; WARN for expected-but-noteworthy; INFO for normal flow. Validation failures = INFO or DEBUG.

### Error message includes stack trace in user-facing response
`{ "error": "TypeError: cannot read property 'foo' of undefined at ..."}` — leaks internal structure, security risk, terrible UX.
**Rule:** user gets `code` + safe `message` + `request_id`. Operators look up `request_id` in logs to see the stack.

### Retry without idempotency
Retry storm on `POST /charge` → 3 charges. Real prod incident waiting to happen.
**Rule:** retry only with idempotency key OR for naturally idempotent ops (PUT full state, DELETE).

### Retry without backoff/jitter
Tight retry loop: target down → 100 clients × 10 retries × 0 delay = 1000 RPS during downstream outage. Outage prolonged.
**Rule:** exponential backoff + jitter + max attempts. Always.

### Generic `Error` for everything
`throw new Error('user not found')` then catch and `instanceof Error` check. Can't distinguish from any other error.
**Rule:** typed error classes. `class NotFoundError extends Error`. Handler matches type → status code.

### Wrapping every error in a generic envelope, losing original
```ts
catch (e) { throw new InternalError('failed') }
```
Original cause lost. Debug requires guessing.
**Rule:** include `cause`/`from`. Preserve the chain.

### "Just retry" as the only resilience strategy
Retries are useful for transient failures, useless for deterministic bugs. Retrying a SQL syntax error 5 times wastes time.
**Rule:** distinguish transient (retry) from deterministic (fail-fast, alert). Don't retry 4xx, deterministic 5xx, parse errors.

### Throw-then-catch as control flow
Using exceptions for normal branching (e.g., "user not found" as a normal flow path) → exceptions are slow + obscure intent.
**Rule:** sentinel return values (`null`, `Option`, `Result`) for expected absence. Exceptions for unexpected.

### Error logged AND returned to caller
Same error logged at every layer it bubbles through → 5 log lines per error → log volume × users.
**Rule:** log once, at the boundary where the error is surfaced. Inner layers rethrow without logging.

### Background job retries forever
No max attempts → poisoned message loops forever, eats workers, blocks queue.
**Rule:** max attempts. Then DLQ. Then alert.

### `process.exit(1)` in library code
Library kills the host process on error. Caller can't recover.
**Rule:** library throws; only the application's main loop / signal handler decides whether to exit.

## Decision Framework

| Failure | Response |
|---|---|
| Caller sent invalid input | 4xx with error envelope; log INFO |
| Caller not authenticated | 401; log INFO |
| Resource not found | 404; log INFO unless suspicious pattern |
| Idempotency-key conflict | 409 with previous response; log INFO |
| Downstream HTTP timeout | retry (idempotent) or 503 (non-idempotent); log WARN |
| Downstream HTTP 5xx | retry with backoff; log WARN |
| Downstream rate-limited (429) | respect Retry-After; log WARN |
| Database connection lost | retry once with new connection; if fail, 503; log ERROR |
| Validation passes but business rule violated | 422 with specifics; log INFO |
| Unexpected exception | 500 with generic message + request_id; log ERROR + alert |
| Background job fails | retry per policy; on exhaustion → DLQ + alert |
| Critical invariant violated mid-request | log ERROR + abort request (don't return partial bad data) |

## Cost Model

| Pattern | Cost when wrong |
|---|---|
| Empty catch block | Bug invisible; surfaces only as user complaint or incident |
| Retry without idempotency | Duplicate writes; data corruption; potential financial loss |
| No circuit breaker on flaky downstream | Your service degrades when downstream does; cascading outage |
| Generic 500 on validation errors | Frontend shows "something went wrong"; UX suffers; oncall paged falsely |
| No DLQ on background jobs | Silent data loss; processing gaps invisible |
| Stack trace in user response | Information leak; security review failure |
| Excess error logging | Log volume cost; signal-to-noise drops; real errors hidden |

## Red Flags in Diff

- `try { ... } catch (e) {}` empty catch → flag.
- `try { ... } catch (e) { console.log(e); }` log-and-continue without rethrow or specific handling → flag (likely swallowing).
- New external call without timeout option → flag.
- New retry loop without exponential backoff + jitter + cap → flag.
- New retry on a non-idempotent op without idempotency key → flag.
- New catch-all in a request handler returning generic error → flag (use error middleware).
- `throw new Error('...')` for distinct error categories without typed subclasses → flag.
- Stack trace / internal type included in error response body → flag (info leak).
- New background job without DLQ destination on exhaustion → flag.
- Logging at ERROR level for expected paths (validation, 404 from search) → flag (alert noise).
- New `process.exit` / `os._exit` / `panic!` outside main entrypoint → flag.
- Error message constructed by string-concatenating user input → flag (log injection).
- New error envelope shape that doesn't match the project's existing format → flag (drift).
- Catching base `Exception` / `Error` and silently mapping to 200 success response → flag immediately.
