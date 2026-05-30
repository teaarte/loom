---
tags: [concurrency, async, parallel, race-condition, atomicity, locks, retry]
stack_signals: []
summary: |
  Concurrency design and race-condition reasoning — atomicity is bought, not
  assumed. Patterns for Promise.all, async gather, queues, locks, and shared
  state mutation.
when_to_load: |
  Task touches async functions, parallel work, queues, locks, atomic
  operations, retry/timeout logic, request handlers under load, background
  jobs, or race-condition-prone state mutations. Diff including Promise.all,
  asyncio.gather, parallel HTTP calls, mutex/lock usage, or read-modify-write
  patterns on shared state also qualifies.
agent_hints: [challenger-reviewer, logic-reviewer, security]
---

# Concurrency — Senior Stance

## When this applies
Load when task touches: async functions, parallel work, queues, locks, atomic operations, retry/timeout logic, request handlers under load, background jobs, race-condition-prone state mutations. Reviewer (especially Challenger) auto-loads when diff includes `Promise.all`, `asyncio.gather`, parallel HTTP calls, mutex/lock usage, or any read-modify-write pattern on shared state.

## Default Stance
Concurrency bugs hide in dev (single user, single thread) and surface in prod (10k QPS). Default to "is there a race condition here?" before "does this look right?". Atomicity is bought, not assumed. Two operations are atomic only when explicitly composed atomically (transaction, single SQL statement, atomic CPU instruction, single Redis command). Everything else is racy.

## Patterns (use these)

### Atomic operations only via primitives
- Database: single statement (`UPDATE … SET n = n + 1`) is atomic. Multi-statement requires a transaction with proper isolation.
- Redis: single command is atomic. Multi-command needs MULTI or Lua script.
- In-process: language-level atomics (`atomic.AddInt64`, `Mutex`, `synchronized`, etc.) — never your own flag-and-check loop.

### Locking strategies
- **Optimistic locking** — read with version, write `WHERE version = X`. Retry on failure. Best when contention is low.
- **Pessimistic locking** — `SELECT … FOR UPDATE`. Blocks others. Best when contention is high but lock duration is short.
- **Distributed lock** — Redis SET NX EX (single-node) for soft mutex. Postgres advisory lock for hard cross-process mutex. NEVER Redlock for hard mutex (see redis.md).

### Idempotency over locking
For external-facing operations, idempotency keys + DB unique constraints often beat distributed locks:
- Client sends `Idempotency-Key`. Server records it with response. Replays return cached.
- DB unique constraint prevents duplicates if multiple workers process the same job.
- Cheaper than locks; failure mode is "rejected duplicate", not "deadlock".

### Backpressure
Every queue has a bounded size. Every worker pool has a bounded count. When full, callers must back off (429 / drop / slow-path) — NOT pile on. Without backpressure, queue grows unbounded → memory pressure → slow shutdowns → cascading outage.

### Timeouts everywhere
Every external call (HTTP, DB query, Redis, RPC) has an explicit timeout. Default = "wait forever" = ticking time bomb.
- HTTP client timeouts: connect, read, total. Set all three.
- DB statement timeout (Postgres `statement_timeout`).
- Test that the timeout actually fires (chaos engineering, fault injection).

### Retry policy with jitter
On transient failures (5xx, timeout, connection-reset):
- Exponential backoff: `base * 2^attempt`.
- Jitter: random 0-base added per attempt. Without jitter, retries from many clients synchronize → thundering herd.
- Cap attempts: 3-5. Beyond that, escalate (DLQ, alert).
- Don't retry non-idempotent operations without idempotency keys.

### Circuit breakers
Wrap external dependencies in a circuit breaker:
- **Closed:** normal traffic.
- **Open:** fail fast (return cached/error) for N seconds. Set when error rate exceeds threshold.
- **Half-open:** let one request through; if it succeeds, close.
Saves the downstream from your retry storm during its outage.

### Single-writer principle
For any piece of state, exactly one component writes; everyone else reads. Multi-writer state without coordination = bug pending.
- DB row contention → queue + single worker per partition.
- Cache invalidation → write-through from the same component that owns the source.
- Filesystem mutation → owned by one process.

### Lock ordering to prevent deadlocks
If you must take multiple locks, always acquire them in the same global order. `lock(A) → lock(B)` everywhere; never `lock(B) → lock(A)` somewhere else.

### Read-modify-write must be guarded
```ts
// BAD
const v = await store.get(k);
await store.put(k, v + 1);

// GOOD (atomic)
await store.increment(k);
// OR
await store.casUpdate(k, expectedVersion, v + 1);
```

## Anti-Patterns (DO NOT)

### Lock then await external call
```ts
mutex.acquire();
const result = await fetch(externalUrl); // 30s
mutex.release();
```
**Why it bites:** lock held for entire external call duration. Other waiters block 30s. External slowdown = your service slowdown × concurrency.
**Rule:** do work outside the lock. Lock only the critical section that touches shared state.

### Concurrent retries without idempotency
3 clients retry the same `POST /charge` after a timeout. 3 charges happen.
**Rule:** idempotency keys are mandatory before allowing retries.

### Unbounded `Promise.all` / `asyncio.gather`
```ts
const results = await Promise.all(items.map(item => fetchOne(item)));
```
With `items.length = 10000`, you fire 10000 concurrent requests. DB connection pool exhausted, target service rate-limited, OOM possible.
**Rule:** bounded concurrency (`p-limit`, `asyncio.Semaphore`, worker pool with cap).

### Sleep-based "wait for" loops
```ts
while (!ready()) await sleep(100);
```
Polls forever, starves event loop, doesn't scale.
**Rule:** event-driven (subscribe, await condition, future/promise resolved by notifier).

### Shared mutable state across requests
Module-level counter, cache map, "last user" reference.
**Rule:** request-scoped state, OR explicit mutex/atomic, OR push to external store (Redis).

### Async work fired and not awaited
```ts
async function handle(req) {
  doExpensiveWorkInBackground(); // unawaited
  return { ok: true };
}
```
**Why it bites:** rejection unhandled, lifecycle untied to request, lambda may freeze before completion, no error propagation.
**Rule:** if work is fire-and-forget, push to a real queue (with at-least-once semantics). Don't rely on event loop background tasks.

### Default-no-timeout on HTTP/DB clients
Many libraries default to no timeout. One slow downstream pins your worker forever.
**Rule:** explicit timeouts at client construction. Reject implicit defaults.

### Retrying on non-idempotent operations
`POST /charge` failed → retry → second charge.
**Rule:** retries only when (a) idempotency key in place, OR (b) operation is naturally idempotent (PUT with full state, DELETE).

### Distributed transactions (2PC across services)
"Both services must commit OR both rollback."
**Why it bites:** 2PC has known failure modes (coordinator crashes), needs participant cooperation, has latency cost. Most "distributed transactions" in the wild are buggy.
**Rule:** use saga pattern (compensating actions on failure) OR design so eventual consistency is acceptable.

### `forEach` with async callback
```ts
items.forEach(async (i) => await save(i));
```
**Why it bites:** `forEach` doesn't await the promises — they all fire concurrently AND the function returns before completion. You think it's sequential; it isn't.
**Rule:** `for...of` with await for sequential; `Promise.all` (with concurrency cap) for parallel.

### Testing without concurrency
Tests run single-threaded; bug never reproduces. Then prod has 100 QPS, race condition fires.
**Rule:** test concurrent paths explicitly (parallel calls in a single test, fault injection).

## Decision Framework

| Situation | Choice |
|---|---|
| Counter incremented from many places | Atomic `INCR` (Redis) or DB `UPDATE … SET n = n + 1` |
| Read-modify-write | Transaction with `SELECT … FOR UPDATE`, OR optimistic lock with version, OR idempotent rewrite |
| Process N items in parallel | Bounded concurrency (semaphore, worker pool, `p-limit(N)`) |
| External call inside critical section | Refactor: do call outside, lock only the shared-state mutation |
| Retry on transient error | Exponential backoff + jitter + cap attempts |
| Strong cross-service consistency | Saga pattern with compensating actions; avoid 2PC |
| Mutex across replicas | Postgres advisory lock or single-node Redis lock; NOT Redlock for safety |
| Background work after request | Real queue with persistence; not fire-and-forget Promise |
| Long-poll vs WebSocket vs SSE | SSE for server-to-client streaming; WS for bidirectional; polling only when neither available |

## Cost Model

| Pattern | Cost when wrong |
|---|---|
| Lock around external call | 1 slow downstream → all locked-paths slow → cascading outage |
| Unbounded parallel calls | DB pool exhaustion, target rate limit, OOM |
| No timeout on HTTP client | One stuck request pins a worker forever |
| Retry without jitter | Thundering herd amplifies downstream outage |
| Read-modify-write race | Last-write-wins data corruption; silent until audit catches it |
| Fire-and-forget background work | Up to 100% of those calls lost on lambda freeze / process restart |
| Synchronization via sleep loop | Wastes CPU, scales to ~10 concurrent before degrading |

## Red Flags in Diff

- `Promise.all(arr.map(...))` where `arr.length` could be > 100 → flag (bounded concurrency needed).
- New `setTimeout(fn, 0)` / `setImmediate` to "fix race condition" → flag (almost always wrong fix).
- `await fetch(url)` without explicit timeout option → flag.
- New retry loop without backoff/jitter/cap → flag.
- `mutex.acquire()` holding across an `await` of an external call → flag.
- `forEach(async ...)` → flag (doesn't await).
- New module-level `let`/`var` mutated in a request handler → flag (shared mutable state).
- Read-then-write on a row without transaction or version check → flag (race condition).
- `try { await ... } catch {}` swallowing all errors silently → flag.
- New background task fired with `void doWork()` or unawaited promise → flag.
- New external HTTP/DB/Redis client constructed inline per request (not pooled) → flag.
- "Retry forever" loop without exit condition → flag.
- Distributed lock implemented as `setIfNotExists` then separate `expire` → flag (race window — see redis.md).
- 2PC / "atomic across services" claim in plan or code → flag for saga refactor.
