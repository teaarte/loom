---
tags: [caching, cdn, redis, http-cache, react-query, swr, invalidation, staleness]
stack_signals: []
summary: |
  Caching design and invalidation discipline — every cache layer is a stale
  copy. Patterns for HTTP cache, CDN, Redis, React Query / SWR, Next.js
  Data/Route caches, and the invalidation contract that makes them safe.
when_to_load: |
  Task touches HTTP cache headers, CDN config, in-memory cache, Redis cache,
  browser cache, query cache (React Query / SWR / RTK Query / Apollo),
  Next.js Data/Route/Full-Route cache, server-side render cache, or
  materialized views. Diff with cache TTLs, invalidation logic, revalidate,
  cacheTag, cacheLife, staleTime, Cache-Control, ETag, or mutate() qualifies.
agent_hints: [logic-reviewer, performance, challenger-reviewer]
---

# Caching — Senior Stance

## When this applies
Load when task touches: HTTP cache headers, CDN config, in-memory cache, Redis cache, browser cache, query cache (React Query / SWR / RTK Query / Apollo), Next.js Data/Route/Full-Route cache, server-side render cache, materialized views. Reviewer auto-loads when diff includes cache TTLs, invalidation logic, `revalidate`, `cacheTag`, `cacheLife`, `staleTime`, `Cache-Control`, `ETag`, `mutate()`.

## Default Stance
The hardest part of caching isn't speed — it's correctness under invalidation. Every cache layer is a copy that may be stale. Add a cache only when (a) you've measured the underlying call is expensive, (b) the data has a clear invalidation event or a tolerable staleness window, (c) you've designed how the cache empties. If you can't answer "what happens when the source changes?" — don't cache yet.

## Patterns (use these)

### Choose the layer based on shape

| Layer | Good for | Cost |
|---|---|---|
| HTTP / CDN | Public, immutable or long-TTL responses | Hard to invalidate per-user |
| Browser HTTP cache | Static assets, idempotent GET | User-controlled, can be bypassed |
| Service-worker cache | Offline-first, PWA | Complexity, version skew |
| In-memory app cache (per-instance LRU) | Hot small data with short TTL, per-process | Inconsistent across instances, lost on restart |
| Redis cache | Cross-instance hot reads, sessions, rate state | Network round-trip, single point |
| DB query cache (built-in or materialized view) | Aggregations, joins refreshed periodically | Refresh window staleness |
| Client-side query cache (React Query / SWR) | UI data, deduped fetches | Per-tab; needs explicit invalidation |
| Edge cache (Vercel, Cloudflare) | Per-user-segment static-ish content | Tag-based invalidation needed |

Pick the **outermost** layer that matches the access pattern. Caching deeper than necessary multiplies invalidation surfaces.

### Invalidation strategy — name it explicitly

For every cache, document one of:
- **TTL only** — accept staleness up to TTL. Simplest, default for read-heavy approximate data.
- **Event-driven** — write path also invalidates (delete key, bump tag, increment version). Use when stale = wrong.
- **Versioned key** — key includes a version/etag; on change, new version auto-evicts old via TTL. Avoids the "did we forget to invalidate?" class of bug.
- **Write-through** — write goes to both cache and source. Cache is always fresh; cost is doubled write latency.
- **Read-through with refresh-ahead** — refresh proactively before expiry. Hides cold misses from users.

### TTL — pick it deliberately

- **Public read-mostly with weak freshness** — minutes to hours.
- **User-specific read-mostly** — seconds to minutes.
- **Computed aggregations** — depends on tolerable staleness; document it.
- **Auth / permission decisions** — seconds at most. Stale auth = security bug.
- **Always set a backup TTL even with event-driven invalidation** — bugs happen.

### Cache-Aside (lazy loading) — the canonical pattern

```
read(key):
  v = cache.get(key)
  if v: return v
  v = source.load(key)
  cache.set(key, v, ttl=T)
  return v
```

This is correct ONLY with stampede protection (see anti-patterns). Add it from day one.

### Stampede protection
Cold cache + high traffic = N concurrent loads of the same expensive thing. Pick one:
- **Lock-around-fill** — first miss acquires a key-scoped lock, others wait or serve stale.
- **Probabilistic early refresh (XFetch)** — on read, with probability proportional to how-close-to-expiry, refresh proactively. Smooths traffic.
- **Single-flight in-process** — dedupe concurrent fills inside one instance. Doesn't help across instances; combine with one of the above.

### Versioned keys for safe schema changes
When the cached payload shape may change, include a version:
```
key = `user:v3:${id}`
```
Old version's keys evict naturally via TTL. No mass-purge needed. No "old version stuck in cache for a week" bugs.

### Tag-based invalidation
For Next.js / Cloudflare / Vercel edge: tag related entries (`['user:123', 'team:42']`), invalidate by tag on write. Avoids enumerating keys; matches "what changed in the source" to "what to evict".

### Cache the result, not the request
Cache key = a normalized representation of the **answer**, not the URL. Two different URLs that produce the same answer should hit the same cache slot. Two URLs with same query params in different order should normalize.

### Negative caching
Cache "not found" too — with shorter TTL. Otherwise a 404 hammered repeatedly causes repeated DB lookups.

## Anti-Patterns (DO NOT)

### No TTL ("we'll invalidate manually")
**Why it bites:** invalidation bugs are forever. One missed write path = stale data permanently. Memory grows.
**Rule:** TTL is mandatory. Even with event-driven invalidation, set a backup TTL ("at most this stale even if we screw up").

### Cache stampede on hot key
**Why it bites:** cache miss → 1000 simultaneous loads → DB CPU spike → DB latency up → all caches expire while loads run → worse stampede next minute.
**Rule:** stampede protection from day one on any cache key with > 100 reads/sec.

### Caching auth/permission decisions for minutes
**Why it bites:** revoke a user's permission, they keep working for the cache TTL. Real security incident.
**Rule:** auth cache TTL ≤ 30 seconds, OR invalidate on revoke event, OR don't cache auth at all.

### Caching at multiple layers without invalidation alignment
**Why it bites:** invalidate L1 (Redis) but L2 (CDN) still serves stale. Or browser HTTP cache holds the old response. Each layer has independent TTL.
**Rule:** if you cache at multiple layers, invalidation must hit all of them. Document which layer holds what for how long.

### `Cache-Control: public` on per-user data
**Why it bites:** user A's response cached by CDN, served to user B. Privacy breach, data leak.
**Rule:** per-user data → `Cache-Control: private` always. Or include user identifier in URL/key and use edge cache with proper key.

### Storing huge payloads in cache
**Why it bites:** 5MB cache entry × 10000 users = 50GB Redis. Cost and latency explode.
**Rule:** cache references / IDs / small projections. Fetch full data on demand if needed. Or cache the bits actually rendered.

### Reading-only cache, never refreshed
**Why it bites:** TTL expires, cache empty, all reads go to DB until refilled. Cold-start tax on every TTL boundary.
**Rule:** refresh-ahead or lock-around-fill so users never see the cold path.

### Cache invalidation by enumerating keys
**Why it bites:** "delete all `user:*` keys" → `KEYS user:*` → blocks Redis / iterates massive keyspace. On 10M keys = outage.
**Rule:** tag-based invalidation, or version bump (atomic, instant), or accept TTL window.

### Conditional caching ("only cache if user is logged out")
**Why it bites:** branching makes invalidation logic non-uniform. Bug: a logged-in user's query slips into a public cache slot.
**Rule:** different cache namespaces for different access categories. Don't share keys across auth boundaries.

### Caching the bug
You found a slow query → cache it → slow query is now hidden but still fires on miss. Cache hides production load, masks the real issue (missing index, N+1, wrong query).
**Rule:** cache after fixing the underlying cost where reasonable. Cache as a layer, not a band-aid.

### `revalidate: 0` / `cache: 'no-store'` everywhere "to be safe"
**Why it bites:** every request = full backend hit. Wastes the entire caching infrastructure.
**Rule:** opt-out caching is the wrong default. Pick a TTL that matches the staleness tolerance.

### Different TTLs for the same data across endpoints
**Why it bites:** one endpoint serves 10s-stale, another serves 5min-stale, user sees inconsistent state across pages.
**Rule:** the staleness tolerance is a property of the data, not the endpoint. Document and align.

## Decision Framework

| Situation | Choice |
|---|---|
| Same data fetched many places in UI | Client query cache (React Query / SWR), shared key |
| Public mostly-static page | CDN/edge cache + tag invalidation |
| Per-user dashboard data | Per-user Redis key, short TTL, event-invalidate on write |
| Expensive aggregation refreshed nightly | Materialized view in DB |
| Hot read of a single small value (1000+/sec) | In-memory LRU per instance + Redis fallback |
| Mutation invalidates many entries | Tag-based, OR version-bump pattern |
| Auth/permission check | Don't cache, OR ≤30s TTL with explicit invalidate on grant change |
| Analytics counter | Redis `INCR`, batched flush to source |
| Image/asset | CDN + immutable URL with version hash |
| Search results page 1, 2, 3 | Cache by `(query, page)`; invalidate by query on data change |

## Cost Model

| Layer | Hit cost | Miss cost (approx) |
|---|---|---|
| Browser HTTP | < 1ms | + full request to server |
| CDN/edge | 5-30ms | + origin fetch |
| In-memory LRU | < 100µs | + downstream load |
| Redis (same region) | 0.5-1ms | + source load |
| DB query cache | varies by warmness | + planning + execution |

| Anti-pattern | Cost when wrong |
|---|---|
| No stampede protection | DB CPU spike during high traffic + cache flush |
| No TTL with bug | Stale data accumulates, eventual user-facing wrongness |
| Long auth TTL | Revoked perms still active = security |
| Public cache on private data | Cross-user data leak |
| Mass enumeration invalidate | Redis stall, possible outage |

## Red Flags in Diff

- New cache write without TTL set inline → flag.
- New cache fill without stampede mitigation on a path the planner described as hot → flag.
- `Cache-Control: public, max-age=...` on per-user response → flag immediately.
- TTL > 60 seconds on auth / permission / billing-related data → flag.
- `KEYS pattern*` or `SCAN` over the entire keyspace called from a write path → flag.
- Cache invalidation that loops over a list to delete keys, list size unbounded → flag.
- Cache key without version/namespace prefix in a codebase that uses them → flag.
- Two endpoints caching the same logical data with different TTLs → flag.
- Cache fill block under a single mutex covering unrelated keys → flag (lock too coarse).
- New cache layer added without a "how does this get invalidated?" comment or doc → flag.
- `staleTime: Infinity` / `revalidate: false` on a query whose data clearly changes → flag.
- Cache configured with no `maxmemory` / eviction policy → flag (unbounded memory).
