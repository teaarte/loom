---
tags: [performance, nestjs, nodejs, orm, n-plus-one, backend]
stack_signals:
  - language: [typescript, javascript]
  - project_type: [backend, monorepo]
summary: |
  NestJS / Node.js performance checklist — N+1 patterns, missing indexes,
  pagination, eager loading, ORM mistakes, request-handler hot paths.
when_to_load: |
  Task touches NestJS controllers / services / providers, TypeORM or Prisma
  queries, request-pipeline middleware on a Node.js backend with perf
  concerns or scale targets.
agent_hints: [performance, logic-reviewer, challenger-reviewer]
---

# Performance: NestJS / Node.js

## Database & ORM
- N+1 query patterns (loading relations in loops)
- Missing database indexes (implied by WHERE/ORDER BY columns)
- Missing pagination on list endpoints (unbounded queries)
- Non-parameterized queries prevent database query plan caching (also a security risk)
- Eager loading too many relations (over-fetching)
- Missing select() — fetching all columns when only a few are needed
- Transaction scope too wide (holding locks longer than necessary)

## API & HTTP
- Synchronous operations blocking the event loop (CPU-heavy in request handler)
- Missing caching for expensive repeated operations (Redis, in-memory)
- No rate limiting on public/expensive endpoints
- Large response payloads without pagination or streaming
- Missing compression (gzip/brotli)
- File uploads without size limits
- Missing timeout on external HTTP calls

## Serialization & Validation
- ClassSerializerInterceptor on every response — expensive for hot paths; consider manual DTOs
- class-validator with deeply nested DTOs — use `whitelist: true` and `forbidNonWhitelisted: true`
- JSON serialization of large objects without streaming

## Architecture
- Blocking constructor operations (should be in onModuleInit)
- Synchronous file I/O (readFileSync, writeFileSync)
- Request-scoped providers where singleton would work (Scope.REQUEST propagates to all consumers)
- Unused providers still registered (loaded but never called)
- Missing queue/background job for heavy operations in request path (emails, reports, file processing)
- Circular dependencies via `forwardRef()` — unexpected init overhead

## Memory & Resources
- Event listeners or intervals not cleaned up in onModuleDestroy
- Large objects held in module-scoped variables (memory leak)
- Missing stream processing for large files (loading entire file to memory)
- Unbounded caches without TTL or max size

## Node.js Runtime
- Not utilizing multiple CPU cores — consider cluster mode or worker threads for CPU-bound ops
- Node.js doesn't cache DNS by default — repeated external HTTP calls can suffer from DNS lookup latency
- Verbose logging in production (string formatting overhead even when log level disabled)
- Consider Fastify adapter over Express for high-throughput services (~2x faster)
