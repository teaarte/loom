---
tags: [architecture, design, complexity, refactor, boundaries, service-split]
stack_signals: []
summary: |
  Architectural decision patterns — prefer the cheapest abstraction that
  survives 6 months. Boundary cost framing for service splits, shared
  modules, and async hops.
when_to_load: |
  COMPLEX tasks; task requires architectural decisions; Architect or Planner
  is reasoning about new components, services, or boundaries; refactor scope
  spans multiple modules or introduces a new abstraction layer.
agent_hints: [architect, planner, logic-reviewer, challenger-reviewer]
---

# Architecture Patterns — Senior Stance

## When this applies
Load on COMPLEX tasks, when task requires architectural decisions, or when Architect/Planner is reasoning about new components, services, or boundaries.

## Default Stance
Pick the cheapest abstraction that survives the next 6 months — not the next 5 years. Premature abstraction costs more than wrong abstraction. Reuse > generalize. Boundaries are expensive: every async hop, every service split, every shared module is a maintenance liability that must pay rent in actual decoupling, scaling, or team-ownership benefit. Default to inline / function / module before service / queue / framework.

## Patterns (use these)

### Sync vs Async boundary
- **Sync** when caller needs result for next decision. HTTP request-response, function call, DB query.
- **Async** when caller doesn't block on the work AND failure can be retried independently. Email send, analytics push, cache warmup.
- **Choose async only if**: (a) latency budget allows it, (b) downstream can be retried idempotently, (c) you have observability for the queue.

### Idempotency by design
Every external-facing write endpoint accepts an `idempotency-key` (header or body). Server stores `(key, request-hash) → response` for 24h. Replays return cached response. Without this, every retry is a potential dup-write bug.

### Strong invariants at the edge
Validate input at the system boundary (controller / route handler), then trust internal code. Don't re-validate in every layer. The cost of "defensive everywhere" is unreadable code AND it doesn't actually catch bugs — bugs come from missing validation, not from "we only validated once".

### Failure modes named explicitly
For every new service/handler, list in the plan: what happens on (a) downstream timeout, (b) downstream 5xx, (c) partial write, (d) duplicate request, (e) caller disconnects mid-write. If you can't answer, you don't have a design.

### Single source of truth
For any piece of state, exactly one component owns the write. Everyone else reads. Multi-writer state without a coordination protocol = race condition waiting to ship.

## Anti-Patterns (DO NOT)

### Premature service split
Splitting a function into a microservice because "it might scale" but it has zero independent scaling pressure today.
**Why it bites:** every cross-service call adds 1-50ms latency, retry logic, network failure modes, deploy coordination, observability gap, and a team boundary that may not match the actual ownership. Roll back via merge is much harder than roll forward via split.
**Sign:** the new service has the same deploy cadence and team as the caller.

### Generic abstraction layer at the start
"Repository" / "Service" / "Strategy" pattern wrapping a single concrete implementation, "for future extension".
**Why it bites:** you pay the indirection cost (3 files instead of 1, harder to navigate, mental model overhead) for an extension that 80% of the time never comes. When it comes, the abstraction usually doesn't fit anyway because the second use case has different shape.
**Rule:** wait for the second concrete use case, then refactor.

### Shared mutable state across modules
Singletons holding cache, config, or connection state mutated from multiple call sites.
**Why it bites:** test isolation breaks. Hot reload breaks. Race conditions appear at scale, not in dev. One service touched the singleton in a different module last week and you don't know.
**Rule:** if it's mutable and shared, put it behind a single owning module with a narrow interface, or pass it explicitly.

### Async for what's actually sync
Wrapping a fast in-process function in a queue + worker because "it's cleaner".
**Why it bites:** debug surface explodes (queue, worker, retry, DLQ, observability), latency goes up (queue lag), and you have eventually-consistent state where strongly-consistent state was correct.
**Sign:** the worker reads result from DB and the caller polls for it.

### Cross-cutting framework before need
Building a generic event bus / plugin system / DSL before there are 3 concrete users.
**Why it bites:** you're designing in the dark. By the time real users appear, the API is wrong.
**Rule:** copy-paste 3 times, then extract.

### Layered architecture as ritual
Auto-creating Controller → Service → Repository → Entity layers for endpoints that just `SELECT` and return.
**Why it bites:** 4 files to add a column. Reading any single piece of code requires opening 4 tabs.
**Rule:** if the layer adds zero logic, delete it. Keep layers where logic lives.

## Decision Framework

| Situation | Default | Reason |
|---|---|---|
| New CRUD endpoint, no logic | Inline in route handler | Layer count = logic count |
| New write endpoint with side-effects | Sync core + async side-effect via queue | Side-effects retry independently |
| Need to share state between requests | Redis / DB / explicit cache layer | Never module-level globals |
| New cross-team boundary needed | Library / interface in same repo first | Service split only when team owns deploy |
| State machine with 3+ states | Explicit state column + transition fn | Don't infer state from booleans |
| Read-heavy aggregation | Materialized view / read replica | Don't do app-side aggregation across millions of rows |
| Write contention point | Queue + single worker | Avoid multi-writer races |

## Cost Model (rough, defaults)

| Decision | Cost when wrong |
|---|---|
| Service split | 2-4 weeks to undo (re-merge, re-deploy, re-observability) |
| Async for sync work | Latency +50ms minimum, debug 5x harder |
| Generic abstraction prematurely | 2-3 days dev time, plus ongoing reading cost forever |
| Missing idempotency key | First prod retry → duplicate write → data corruption incident |
| Shared mutable singleton | Race condition at scale; not reproducible in dev |
| Layered architecture without logic | 4x code volume, 2x review time, no benefit |

## Red Flags in Diff (reviewer hunts these)

- New service / module / package introduced for a single caller — flag for justification.
- New abstraction with one concrete impl — flag for "wait for second user".
- Async path added but caller polls for result — flag as accidental complexity.
- Module-level `let` / `var` mutated in handler code — flag as shared mutable state.
- Write endpoint without idempotency key in route signature — flag as retry hazard.
- New layer (controller/service/repo) with no logic, just pass-through — flag as ritual.
- "TODO: handle retry" / "for future extension" comments — fail-fast: either handle now or remove the comment.
- New interface with single implementer + `*Impl` suffix — almost always wrong.
