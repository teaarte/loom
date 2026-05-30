---
tags: [performance, python, fastapi, asyncio, backend]
stack_signals:
  - language: [python]
  - project_type: [backend, monorepo]
summary: |
  Python / FastAPI / asyncio performance checklist — N+1, pagination, async
  pool sizing, transaction scope, gather vs serial calls.
when_to_load: |
  Task touches Python backend code (FastAPI, Django, Flask) with perf
  concerns, scale targets, or async/await + DB interaction. Diff in
  *.py with route handlers, async functions, or DB query construction.
agent_hints: [performance, logic-reviewer, challenger-reviewer]
---

# Performance: Python / FastAPI / asyncio

## Database
- N+1 queries (loading in loops instead of batch)
- Missing database indexes (implied by WHERE/ORDER BY columns)
- Missing pagination on list endpoints (unbounded queries)
- Transaction scope too wide (holding DB connections across gRPC/HTTP calls)
- asyncpg pool exhaustion — missing `min_size`/`max_size` tuning, or not releasing connections promptly
- Unbounded caches without TTL

## Async Runtime
- Blocking sync calls in async handlers (sync I/O, CPU-heavy ops without executor)
- GIL-bound CPU work — `asyncio.to_thread()` only helps I/O; CPU parallelism needs `ProcessPoolExecutor`
- Missing `asyncio.Semaphore` for concurrent external calls
- Missing timeout on external HTTP/gRPC calls (`httpx` timeout, `asyncio.wait_for`)
- Sync file I/O in async context

## API & HTTP
- Missing connection pool limits on outbound HTTP clients
- Large response payloads without pagination
- Missing `StreamingResponse` for large data exports (building entire response in memory)
- Heavy work in request path that should use `BackgroundTasks` or task queue
- Missing response class optimization (`ORJSONResponse` vs default `JSONResponse` for large payloads)

## Serialization & Validation
- Pydantic model validation cost on hot paths — use `model_construct` for trusted internal data
- Repeated validation of same data across middleware/dependencies
- `json.dumps` for large payloads — use `orjson` for 3-10x speedup

## FastAPI-Specific
- Heavy middleware running on every request that could be scoped to specific routes
- `Depends()` chains re-executing expensive lookups per request without caching
- Not pre-warming connection pools at startup (lifespan handler)
- Excessive DEBUG-level logging in production (string formatting even when log level disabled)
- Import-time side effects slowing startup
