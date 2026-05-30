---
tags: [postgres, sql, database, migrations, query-perf, n-plus-one, indexes, backend]
stack_signals:
  - project_type: [backend, monorepo]
summary: |
  PostgreSQL query and migration discipline — EXPLAIN ANALYZE before merging,
  N+1 hunting, index design, migration safety on production-sized tables.
when_to_load: |
  Task touches SQL files, ORM schema (Prisma *.prisma, TypeORM entities,
  SQLAlchemy models), migrations, raw queries, query builders, or DB
  connection setup. Diff including *.sql, schema changes, or query-shape
  changes qualifies.
agent_hints: [logic-reviewer, performance, challenger-reviewer]
---

# PostgreSQL — Senior Stance

## When this applies
Load when the task touches: SQL files, ORM schema (Prisma `*.prisma`, TypeORM entities, SQLAlchemy models), migrations, raw queries, query builders, or DB connection setup. Reviewer auto-loads when diff includes `*.sql`, schema changes, or query-shape changes.

## Default Stance
Treat the DB as the slowest and most expensive component. Every query is until-proven-otherwise a potential N+1, missing index, or full table scan. EXPLAIN before merging anything that's not trivially indexed. Migrations on production-sized tables are operational events, not code changes — they are designed for rollback, then run.

## Patterns (use these)

### Always run EXPLAIN (ANALYZE) on new queries
For any query touching > 1 table or > 10K rows. Look for:
- `Seq Scan` on tables > 10K rows → missing index.
- `Nested Loop` with high outer cardinality → index missing or wrong.
- `Filter:` removing > 90% of rows → index doesn't cover the predicate.
- Hash/Sort spilling to disk → query needs rewriting or work_mem tuning.

### Index choice
- **B-tree** — equality, range, ORDER BY. Default.
- **Partial index** — `WHERE status = 'active'` predicate that hits 5% of rows. Massive win on storage and write cost.
- **Composite index** — order matters. Leading column = most selective AND most often filtered.
- **GIN** — JSONB containment, full-text, array containment.
- **GiST** — geo, range types, similarity.
- **BRIN** — append-only timestamp columns on huge tables.
- Covering index (`INCLUDE`) — when query can be answered from index alone (index-only scan).

### Transactions and isolation
- Default `READ COMMITTED` is fine for most. Don't lower it without thinking.
- `REPEATABLE READ` for read-modify-write that needs to see consistent snapshot. Note: serialization failures must be retried by the caller.
- `SERIALIZABLE` for true correctness across rows but cost is real — only when needed.
- Wrap multi-step writes in a transaction. Always.
- Avoid long-running transactions: they hold locks AND prevent VACUUM from reclaiming dead tuples → table bloat.

### Migration safety on big tables
- Adding a NOT NULL column with default in PG ≥11 → metadata-only on most recent versions, but **verify on the actual PG version** in use. On older versions: rewrite hits whole table → outage on >10M rows.
- Adding an index → use `CREATE INDEX CONCURRENTLY` outside transaction. Plain `CREATE INDEX` locks writes for duration.
- Dropping a column → two-phase: ignore in app first (deploy), then drop in next migration. Never drop and deploy together.
- Renaming a column → never rename live. Add new, dual-write, backfill, switch reads, drop old. Multiple deploys.
- Foreign key add on populated table → `NOT VALID` then `VALIDATE CONSTRAINT` separately. Validation is fast read-only check; full add takes write lock.

### Connection pooling
- Use a pool. Limit per-instance connections to (max_connections - reserved) / instance_count.
- For serverless / function compute → use a connection pooler (PgBouncer in transaction mode, RDS Proxy, Supabase pooler). Direct connections from Lambda = burns through max_connections in seconds.
- Pool size > 20 per instance is almost always wrong; tune with `pg_stat_activity` not by guessing.

### N+1 detection
- ORM lazy-load in a loop is the canonical case.
- Fix: explicit `include` / `select_related` / `JOIN`, or batch loader (DataLoader pattern).
- Cost: 100 rows × 5ms per N+1 query = 500ms latency, instead of one 20ms join.

## Anti-Patterns (DO NOT)

### `SELECT *` in production code
**Why it bites:** schema evolves, app pulls bytes it doesn't need (network + memory), index-only scan unreachable, breaking change when adding sensitive column.
**Rule:** explicit column list. Always.

### Implicit casts in WHERE
`WHERE id = '123'` where `id` is `bigint`. PG may not use the index. Worse on JSONB.
**Rule:** match types in predicates, especially on indexed columns.

### `OFFSET N` for pagination on big tables
**Why it bites:** OFFSET 10000 = read and discard 10000 rows every page. O(N) per page request. Page 1000 = 10M row scans cumulative.
**Rule:** keyset pagination — `WHERE id > $last_id ORDER BY id LIMIT 50`. Stable, indexable, scales.

### `COUNT(*)` on large filtered tables for "total pages"
**Why it bites:** scans matching rows. Slow on > 1M rows.
**Rule:** approximate counts (PG `pg_class.reltuples`), or "show next page exists" instead of "total count", or cached count.

### `WHERE col IN (subquery returning millions)`
**Why it bites:** PG builds hash of millions of rows. May spill to disk.
**Rule:** rewrite as JOIN or EXISTS, or batch the outer query.

### Long-running transaction holding locks
**Why it bites:** blocks DDL, blocks VACUUM, can deadlock writers, table bloat. Especially in ORMs that auto-open transactions per request and a slow handler keeps it open.
**Rule:** open transaction at last possible moment, commit at first possible moment. Never wait on external API inside a transaction.

### `CREATE INDEX` (without CONCURRENTLY) on prod table > 1M rows
**Why it bites:** AccessExclusiveLock on the table for the index build duration. Writes block. Outage.
**Rule:** always `CREATE INDEX CONCURRENTLY` on prod-sized tables. Run outside migration framework if needed.

### Foreign key without index on referencing column
**Why it bites:** every UPDATE/DELETE on parent locks-checks all child rows. Without index → full scan → lock contention.
**Rule:** always index the FK side. ORMs don't always do this automatically — verify.

### `TEXT` for unbounded user input without limit
**Why it bites:** abuse vector. A single 50MB body kills row size, replication lag, query memory.
**Rule:** explicit `VARCHAR(N)` or `CHECK (length(col) <= N)`.

### JSONB as the schema
Storing all data in `data jsonb` column to "avoid migrations".
**Why it bites:** no FK, no constraints, can't index efficiently without GIN per query shape, debugging is harder, query planner can't optimize. JSONB is great for sparse/variant data; not as a substitute for schema.
**Rule:** structured data → columns. Variant/sparse → JSONB.

### Generated SQL with string concatenation
**Why it bites:** SQL injection, query plan cache miss, parser overhead.
**Rule:** parameterized queries. Always. ORMs do this; raw `pg.query(\`SELECT ... ${userInput}\`)` does not.

### "Soft delete" everywhere via `deleted_at`
**Why it bites:** every query needs `WHERE deleted_at IS NULL`. Forget once → leak. Indexes need partial (`WHERE deleted_at IS NULL`) or they index dead rows. Joins surface deleted rows unexpectedly.
**Rule:** soft-delete only what truly needs audit/recovery; hard-delete the rest. If soft-deleted, partial-index everything.

## Decision Framework

| Situation | Choice | Why |
|---|---|---|
| New filter column on hot read path | Index. Composite if multiple filters together | Filter at index, not after fetch |
| Pagination on big table | Keyset, not OFFSET | OFFSET is O(N) per page |
| Multi-row update inside request handler | Transaction with `SELECT FOR UPDATE` | Prevent concurrent overwrite |
| Table > 100M rows, time-series | Partition by time (monthly/daily) | Scans target one partition |
| Adding NOT NULL column to prod | Add nullable → backfill → set NOT NULL | Avoid rewrite lock |
| Need atomic counter | `UPDATE ... SET n = n + 1 RETURNING n` | Single statement is atomic |
| Concurrent write contention on row | Queue + single worker, OR row-level lock with retry | Don't lock-spin on hot row |
| Need consistent read across queries | Single transaction with `REPEATABLE READ` | Snapshot stability |

## Cost Model (orders of magnitude)

| Operation | Time |
|---|---|
| Index lookup (B-tree, cached) | 0.1ms |
| Sequential scan, 1M rows | 100-500ms |
| Sequential scan, 100M rows | 10-60s — usually unacceptable |
| Index-only scan | 2-5x faster than index scan + heap fetch |
| Single transaction commit (fsync) | 1-10ms |
| FK check on indexed child | 0.1ms |
| FK check on un-indexed child, 1M rows | 100ms+ |

## Red Flags in Diff

- Raw query strings using template literals / `format()` with user-derived input → SQL injection.
- New filter / sort / join column without corresponding index in same migration → flag.
- `OFFSET` in pagination on table that may grow > 10K rows → flag.
- New FK without index on the referencing column → flag.
- `CREATE INDEX` without `CONCURRENTLY` in prod-targeted migration → flag.
- ORM call inside loop body → N+1 candidate.
- Transaction wrapping HTTP/external call → flag (long-running transaction risk).
- New `DROP COLUMN` / `RENAME` in single migration without staged rollout note → flag.
- `.findMany()` / `.find()` without `take` / `LIMIT` on potentially-large set → flag.
- New `JSONB` column where 80% of fields are always-present → flag (probably should be columns).
