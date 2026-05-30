---
tags: [redis, cache, session, queue, rate-limit, pubsub, distributed-lock]
stack_signals:
  - project_type: [backend, monorepo]
summary: |
  Redis design — single-threaded per shard, in-memory budget. Keep keys
  small, commands O(1) or bounded, and design every feature to degrade
  gracefully on a Redis blip.
when_to_load: |
  Task touches cache layer, session store, rate limiter, queue (BullMQ,
  Sidekiq, RQ), pub/sub, distributed lock, ratelimit, or real-time presence.
  Diff including Redis client calls (redis., ioredis, node-redis, redis-py,
  lettuce, Bull, BullMQ, RedisCacheStore) qualifies.
agent_hints: [logic-reviewer, performance, challenger-reviewer]
---

# Redis — Senior Stance

## When this applies
Load when task touches: cache layer, session store, rate limiter, queue (BullMQ, Sidekiq, RQ), pub/sub, distributed lock, ratelimit, real-time presence. Reviewer auto-loads when diff includes Redis client calls (`redis.`, `ioredis`, `node-redis`, `redis-py`, `lettuce`, `Bull`, `BullMQ`, `RedisCacheStore`).

## Default Stance
Redis is single-threaded per shard and held in memory. Every command competes for the same CPU and the same RAM budget. Treat it as a shared resource with a strict SLA: keep keys small, commands O(1) or bounded, and persistence trade-offs explicit. A Redis outage cascades — design every feature so a 30-second Redis blip degrades, not breaks.

## Patterns (use these)

### Pick the right primitive
- **String** — value + optional TTL. Default for cached payload, counter (`INCR`), feature flag.
- **Hash** — object with multiple fields, when you read/write fields independently. Cheaper than JSON-string for partial updates.
- **Set** — uniqueness. Online users, deduplication, tag membership.
- **Sorted Set (ZSET)** — leaderboards, time-ordered streams of bounded size, top-N queries. `ZADD` + `ZRANGE` is the workhorse.
- **List** — simple FIFO queue, recent-N items (`LPUSH` + `LTRIM`).
- **Stream (XADD/XREADGROUP)** — durable queue with consumer groups, replay. Use this for queue-of-record (not List).
- **HyperLogLog** — approximate cardinality. 12KB for billions of entries. Don't reach for Set when "approximate count of unique" is enough.
- **Bitmap** — daily active flags. `SETBIT user_id`, `BITCOUNT`. 1MB = 8M users.

### Persistence — choose deliberately
- **None (cache only)** — RDB off, AOF off. Acceptable for pure cache. Restart = empty.
- **RDB snapshots** — periodic dump. Loses last N seconds. Cheap. Default for many setups.
- **AOF (appendonly yes, fsync everysec)** — fsync each second. Loses ≤1s on crash. The right default for state-bearing Redis.
- **AOF fsync always** — every write fsync'd. 10x slower writes. Almost never the right choice.
- Replication is not a backup. Use snapshots for backup.

### Eviction policy
Set explicit `maxmemory` and `maxmemory-policy`. Default of "no eviction" turns Redis into a wall when full → all writes fail.
- **allkeys-lru** — pure cache.
- **volatile-lru** — mixed cache + persistent keys (only TTL'd keys evict).
- **noeviction** — only when Redis is single-purpose state with strict guarantees.

### TTL discipline
Every cache key has a TTL. No exceptions. Without TTL, a bug accumulates dead data forever. Set TTL on `SET` directly (`SET k v EX 600`), not as a separate `EXPIRE`.

### Pipelining and MULTI
- **Pipeline** — batch many commands without atomicity. ~10x throughput on round-trip-bound workloads.
- **MULTI/EXEC** — atomic multi-command. All-or-nothing. Use when you need atomic compose (e.g. `INCR` + `EXPIRE`). Note: still single-threaded, blocks server briefly for the block duration.
- **Lua script (EVAL)** — atomic, but server runs it single-threaded. Keep scripts O(1) or bounded.

### Distributed locking
The naive lock — `SET key value NX EX 10` — is correct for single-node Redis if you also:
1. Use a unique random value per acquirer.
2. Release via Lua script that checks value before DEL (avoids releasing someone else's lock after expiry).

For multi-node Redis cluster: **Redlock has known correctness issues under network partitions.** If you actually need distributed mutual exclusion across replicas, use a real consensus system (Postgres advisory locks, etcd, ZooKeeper). Redlock is "best-effort with a fence token", not "guaranteed mutex".

### Rate limiting
- **Fixed window** — `INCR key`, `EXPIRE key 60` if first. Simple, has boundary spikes.
- **Sliding log** — `ZADD`, prune old, `ZCARD`. Memory-heavy.
- **Token bucket via Lua** — best correctness/cost balance. One Lua script, atomic, bounded.
- For high-volume — use a pre-built lib (`redis-cell` module, `node-rate-limiter-flexible`) instead of writing your own.

### Pub/Sub vs Streams
- **Pub/Sub** — fire-and-forget. Subscriber not connected = message lost. No replay. Use for real-time only when loss is acceptable.
- **Streams** — durable, consumer groups, replay, ack. Use for "queue of work". Default to streams for anything that must not be lost.

### Cache key design
- Namespace prefix: `app:env:entity:id` — `wandr:prod:user:123`. Makes debugging and bulk-purge easy.
- Include version in key when shape may change: `wandr:prod:user:123:v2`. Makes safe rollouts trivial — change version, old cache evicts naturally via TTL.
- Hash large keys: `user:hash(email)` rather than `user:long-email-string`.

## Anti-Patterns (DO NOT)

### `KEYS *` in production
**Why it bites:** O(N) over the entire keyspace, blocks the single thread for the duration. On a 10M-key Redis = full server stall for seconds.
**Rule:** use `SCAN` with `MATCH` and `COUNT`. Iterates with bounded work per call.

### Storing 1MB+ values in a single key
**Why it bites:** `GET` of 1MB blocks the single thread for the network write. Memory fragmentation worsens with large values.
**Rule:** keep values < 100KB. Split into hash fields if needed. For huge blobs, use object storage and put the URL in Redis.

### Using Redis as primary database
**Why it bites:** persistence is best-effort (even AOF every-sec loses 1s). No transactions across multiple keys with rich constraints. No queries beyond key lookup.
**Rule:** Redis = cache + ephemeral state + queue. Source of truth = real DB.

### No TTL on cache keys
**Why it bites:** memory grows monotonically. Eventually `maxmemory` hit, eviction kicks in, but eviction may evict the wrong things. Bugs in cache invalidation accumulate forever.
**Rule:** every cache key has TTL at write time. Even "we'll invalidate manually" — set a backup TTL.

### `SUBSCRIBE` for queue work
**Why it bites:** subscriber dead for 1ms during deploy = message lost forever. No retry. No DLQ.
**Rule:** Streams (`XADD` + `XREADGROUP`) for any work that matters.

### Long-running Lua scripts
**Why it bites:** Lua runs on the single thread. A 100ms script = 100ms freeze of the entire Redis instance for every other client.
**Rule:** Lua must be bounded. No loops over unbounded sets.

### Multiple Redis clients per process without connection pool
**Why it bites:** each client = TCP connection + command queue. Connection storm under load.
**Rule:** one shared client (or a small pool) per process. Configure with retry strategy and backoff.

### Storing JSON-stringified objects when you need partial updates
**Why it bites:** read-modify-write race. Two clients update field A and B → last write wins → one update lost.
**Rule:** use Hash type with `HSET field value`. Field-level atomic updates. Or use Lua script for compound update.

### Cache-aside without stampede protection
**Why it bites:** cache miss → 1000 requests all execute the expensive backing query simultaneously. DB overloaded, sometimes outage.
**Rule:** cache stampede mitigation — see `caching.md` (lock around fill, or probabilistic early refresh, or request coalescing).

### Hot keys (single key getting all the traffic)
**Why it bites:** Redis Cluster shards by key. One hot key = one hot shard = no parallelism. CPU pinned.
**Rule:** if a key is read 10k+ times per second, replicate to local in-memory cache (LRU per app instance) with short TTL. Or shard the key (`counter:0`...`counter:9` and pick at random, sum on read).

### Using `MULTI/EXEC` for "transactions" that aren't actually atomic logic
**Why it bites:** MULTI/EXEC doesn't roll back on error inside the block. Errors in commands inside MULTI return errors, but other commands still execute. People assume rollback semantics — there are none.
**Rule:** if you need conditional atomic logic, use Lua. MULTI/EXEC is just batching with no interleaved commands.

## Decision Framework

| Need | Use | Avoid |
|---|---|---|
| Pure cache, restart-OK | String + TTL, RDB or no persist | AOF always-fsync |
| Session store | Hash + TTL, AOF every-sec | String JSON-blob |
| Counter | `INCR` (atomic) | GET → +1 → SET |
| Top-N | ZSET | sorted Set + manual trim |
| Approximate unique | HyperLogLog | Set with millions of entries |
| Queue, must not lose | Stream + consumer group | Pub/Sub or List |
| Rate limit | Token bucket Lua, or `redis-cell` | Hand-rolled INCR/EXPIRE with race |
| Distributed lock, single node | `SET NX EX` + Lua release | naive `SETNX` then `EXPIRE` (race) |
| Distributed lock, multi-node strong | Postgres advisory lock / etcd | Redlock for hard mutex |
| Real-time messaging, loss-tolerable | Pub/Sub | Streams (overkill) |
| Object with partial updates | Hash | JSON in String |

## Cost Model

| Operation | Cost (single-node, cached, no I/O) |
|---|---|
| `GET` / `SET` | 50-100µs |
| `HSET` / `HGET` | 50-100µs |
| `INCR` | 50-100µs |
| Pipelined batch of 100 ops | 1-2ms total (~10-20µs each) |
| `KEYS *` on 1M keys | 100ms+ blocking |
| Lua script, 100 iterations | 0.5-1ms blocking |
| `SUBSCRIBE` notification | sub-ms when subscriber alive |
| `XADD` to stream | 100µs |

| Storage | Bytes |
|---|---|
| Empty Hash | ~80B |
| String value, 100B payload | ~150B with metadata |
| ZSET, 100 members | ~5KB |
| Stream entry, 100B payload | ~200B |

## Red Flags in Diff

- `KEYS` / `FLUSHDB` / `FLUSHALL` — flag immediately, almost always wrong in app code.
- `SET` without `EX` / TTL — flag (cache key without expiry).
- `SUBSCRIBE` for work-style messaging where loss matters — flag (use Streams).
- `MULTI` / `EXEC` block doing logic that only works if all succeed — flag (Lua instead).
- New Redis client constructed inside a request handler — flag (should be shared).
- Lua script with unbounded loop or `KEYS *`-style iteration — flag.
- Distributed lock implemented as `SETNX` + separate `EXPIRE` → race condition window. Flag.
- Cache fill without stampede protection in hot path → flag.
- Single key receiving high write rate without sharding plan → flag (hot key).
- Storing JSON-stringified blob > 50KB in a String key → flag.
- Lock release `DEL key` without checking the value first → flag (releases someone else's lock).
- Rate limiter using `INCR` + separate `EXPIRE` first-time-key check → race window allows N+1 requests through.
