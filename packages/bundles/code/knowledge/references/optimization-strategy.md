---
tags: [performance, optimization, profiling, latency, throughput, slo]
stack_signals: []
summary: |
  Strategy-level performance discipline — measure before you optimize. Profile,
  hypothesize, change one thing, measure again. Pairs with platform-specific
  perf-*.md files.
when_to_load: |
  Task touches performance-sensitive code, "make it faster" is in scope, a
  perf regression is suspected, or a feature has explicit latency/throughput
  requirements. Preemptive load when CLAUDE.md or task mentions SLO, latency
  budget, "scale to N users", or similar.
agent_hints: [performance, logic-reviewer, challenger-reviewer]
---

# Optimization Strategy — Senior Stance

## When this applies
Load when task touches performance-sensitive code, when "make it faster" is in scope, when a perf regression is suspected, or when a feature has explicit latency/throughput requirements. Performance Agent loads this in addition to platform-specific perf-{stack}.md. Load preemptively when CLAUDE.md or task mentions SLO, latency budget, "scale to N users", or similar.

## Default Stance
Don't optimize what you haven't measured. Most "obviously slow" code is fast enough; most "obviously fine" code has surprises. Profile first, hypothesize, change one thing, measure again. Optimization without measurement is decoration. Once you've measured, fix the biggest hot spot — the long tail rarely matters.

The order: **correct → tested → measured → optimized**. Skip steps and you're guessing.

## Patterns (use these)

### Measure before, measure after
- Establish a baseline: what's slow, by how much, under what load?
- Make the change.
- Re-measure under the same conditions.
- If you can't tell the difference, you didn't optimize anything.

### Profile to find hot spots
Tools by stack:
- Node.js: `--prof` + processed with `--prof-process`, or `clinic.js`, or Chrome DevTools.
- Python: `cProfile` + `snakeviz` or `py-spy` (sampling, low overhead, prod-safe).
- JVM: `async-profiler`, `JFR`.
- Go: `pprof` (built-in).
- Browser: Chrome DevTools Performance tab; Lighthouse for page-level.
- DB: EXPLAIN ANALYZE; `pg_stat_statements`.

Look for: tall stack frames, repeated work per call, calls into expensive primitives (DB, network, parse).

### Latency vs throughput
Different goals, different fixes:
- **Latency** (single-request time): reduce work in the request path. Cache, denormalize, precompute, prefetch.
- **Throughput** (aggregate ops/sec): reduce contention, parallelize, batch, queue.
A change that improves latency may hurt throughput (e.g., always-fresh cache lookup beats stale-while-revalidate for latency, but more DB load → worse throughput).

### Big-O matters when N is large
- 1000 items in a list: O(N) vs O(N²) matters → microseconds vs milliseconds.
- 1M items: O(N) vs O(N²) matters → seconds vs minutes.
- 10 items: O(N²) is fine; readability beats cleverness.
Don't optimize O(N) → O(log N) when N=10. Don't tolerate O(N²) when N=10K.

### Hot loop discipline
For code that runs millions of times per second:
- Avoid allocations inside the loop (object creation, array spread, string concat).
- Avoid closures/functions created per iteration.
- Hoist invariants out of the loop.
- Batch where possible.

For code that runs 100x: clarity beats micro-optimization.

### Caching as last resort, not first
Cache is hard (invalidation, staleness, stampedes — see caching.md). Add a cache only when:
- The underlying call is measurably expensive.
- The data has clear invalidation semantics.
- You've designed how the cache empties.
- The hit rate justifies the complexity.

Often the right answer is "fix the slow query" (add index, denormalize, materialize) — not "cache around it".

### Database-side optimization first
For data-heavy operations, the DB is usually the bottleneck. Before app-side caching:
- Add indexes for new query shapes.
- Rewrite N+1 as JOIN or batch loader.
- Use materialized views for expensive aggregations.
- Consider read replicas for read-heavy paths.

### Bundle-size optimization (frontend)
- Measure with `webpack-bundle-analyzer`, `vite-plugin-visualizer`, `next build` output.
- Code-split routes (lazy / dynamic imports).
- Remove unused deps; replace heavy libs (moment → date-fns → native Intl).
- Tree-shake-friendly imports (`import { format } from 'date-fns'` not `import _ from 'date-fns'`).

### Render performance (frontend)
- Profile with React DevTools Profiler / Vue Devtools.
- Look for unnecessary rerenders. Memo only after profiling identifies the cost.
- Move expensive work off render path: `useMemo` for compute, `useCallback` to stabilize refs, `useDeferredValue` for non-urgent updates.
- React Compiler (when enabled) handles most of this; manual memo becomes anti-pattern.

### Networking
- Reduce round trips: batch where API allows.
- Compression: gzip / brotli for text responses.
- HTTP/2 multiplexing eliminates per-request connection overhead.
- CDN for static assets and edge-cacheable dynamic content.
- Connection pooling for outbound HTTP.

## Anti-Patterns (DO NOT)

### Optimize without measuring
"This loop is slow, let me optimize" — without profiling. Spend a day; benchmark says no improvement.
**Rule:** profile first. The hot spot is rarely where you think.

### Micro-optimize cold paths
Code runs 5 times per day; spend a week making it 20% faster.
**Rule:** ROI matters. Optimize where the wall-clock time lives.

### Cache everything
"Add cache to make it faster" → invalidation bugs ship → stale data shown to users → harder bug to fix than the original perf.
**Rule:** cache only what's measurably expensive AND has clear invalidation. Otherwise fix the underlying cost.

### Premature parallelization
Parallel implementation is harder to debug, harder to read, harder to maintain. If serial is fast enough, leave it alone.
**Rule:** parallelize after measuring serial cost.

### Optimize without context
Same code path: 50ms in dev, 5ms in prod (cached at scale). Optimizing dev path costs eng time, prod doesn't care.
**Rule:** measure under prod-shaped load.

### Synthetic benchmarks unrepresentative of real load
Loop 1M times calling `f(0)` — JIT detects constant, eliminates the call. Benchmark says "f is free". Real callers vary input → JIT doesn't help → f is expensive.
**Rule:** realistic input distribution; warm-up; multiple runs.

### Optimizing without acceptance criteria
"Make it faster" with no target. Spend forever; never know when to stop.
**Rule:** define the target. p95 < 200ms. Bundle < 100KB. Then stop when met.

### "Faster" code that breaks invariants
Removed a defensive check "for perf"; turns out the check was load-bearing in an edge case.
**Rule:** measure, change, re-measure, AND re-test. Performance change must keep tests passing.

### Optimizing the wrong layer
App caches DB result; DB query was actually fast; the slow part was the JSON serialization. Cache helps a little; fixing the serialization helps a lot.
**Rule:** profile points at the layer; fix at the layer the profile points to.

### Memoizing pure functions that are already cheap
`useMemo(() => x + y, [x, y])` — overhead of memo > cost of `+`. Especially with React Compiler.
**Rule:** memo when profile shows it pays. Otherwise it's noise.

### "10x faster" claims without measurement
PR description says "10x faster". No benchmark. No before/after.
**Rule:** include measurement in the PR. Numbers, not vibes.

### Killing readability for micro-perf
`for (let i = 0, l = arr.length; i < l; ++i)` instead of `for (const x of arr)` — saves nanoseconds, costs reader 5 seconds. Hot loop? OK. Cold path? Don't.

## Decision Framework

| Symptom | Investigation order |
|---|---|
| Slow request handler | Profile request path → identify slowest span → fix slowest |
| Slow page load | Lighthouse → bundle analysis → render profile → fix biggest |
| High DB latency | EXPLAIN slowest queries → indexes → denormalize → cache as last resort |
| OOM under load | Heap profile → leaks → unbounded data structures → caching with proper bounds |
| CPU pinned | Profile → hot function → algorithmic vs micro fix |
| Throughput plateau | Identify bottleneck (CPU? IO? DB pool? Lock contention?) → fix that one |
| Tail latency p99 high | Find: GC pauses? Cache miss? DB connection wait? Each has different fix |
| Slow boot/cold start | Lazy-load non-critical modules; warm pools; provisioned concurrency for serverless |

## Cost Model

| Optimization | Typical effort | Typical gain |
|---|---|---|
| Add missing DB index | hours | 10-1000x query speedup |
| Fix N+1 with JOIN | hours | 10-100x for affected request |
| Add Redis cache for hot read | day | 5-10x latency, IF hit rate is high |
| Code-split a heavy route | hours | 30-70% initial bundle reduction |
| Replace heavy lib (moment → date-fns) | hours | 50-80% lib size reduction |
| Memoize expensive React component | minutes | 0% if not on hot path; 10-30% if it is |
| Refactor algorithm O(N²) → O(N log N) | day-week | massive at scale, zero at small N |
| Migrate to faster runtime / lib | weeks-months | 10-50%; high risk |
| Add connection pool | hours | reduces tail latency markedly under load |

| Anti-pattern | Cost when wrong |
|---|---|
| Cache hides slow query | Quality bug shipped via stale data; original problem still there |
| Premature parallelism | Code 5x harder to read, race conditions, no measured win |
| Micro-opt over readability | Slowed team velocity; bug-prone code; nano gain |
| No measurement before / after | Could be ZERO actual improvement, you have no idea |

## Red Flags in Diff

- New `useMemo` / `useCallback` without a profile/comment justifying it (especially with React Compiler enabled) → flag.
- New cache layer added without a TTL OR without invalidation strategy → flag (see caching.md).
- New parallel code (Promise.all, asyncio.gather) without bound on concurrency → flag.
- New "optimization" PR without before/after benchmark numbers → flag.
- New micro-optimized code (manual loops, hand-rolled algorithms) replacing a clear stdlib call without measurement → flag.
- Removed validation / safety check labelled "for perf" → flag.
- Hardcoded "magic number" tunable (timeout, batch size) without comment about source → flag.
- Profile-driven changes affecting hot path without test coverage on the changed paths → flag (perf regression risk).
- New `setImmediate` / `setTimeout(0)` claims to "improve perf" → flag (almost always wrong fix).
- Heavy library added in a code path that already had a lighter alternative → flag.
- Heavy operation moved into render / hot loop → flag.
- New "fast path" with subtly different semantics from the slow path → flag (correctness drift risk).
