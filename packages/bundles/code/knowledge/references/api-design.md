---
tags: [api, contract, rest, graphql, grpc, versioning, idempotency, pagination, backend]
stack_signals:
  - project_type: [backend, monorepo]
summary: |
  Public-contract design for HTTP/RPC/GraphQL endpoints — idempotency, pagination,
  error envelopes, versioning. Treats the API signature as forever-ish and
  prioritises contract shape over implementation detail.
when_to_load: |
  Task touches HTTP/RPC endpoints, GraphQL schema, gRPC proto, OpenAPI spec,
  route handlers, or anything that's a public contract between services /
  frontend and backend / between teams. Diff under routes/, controllers/,
  *.proto, openapi.yaml, GraphQL *.graphql / resolvers, or new public-facing
  functions also qualifies.
agent_hints: [logic-reviewer, challenger-reviewer, security, api-contract]
---

# API Design — Senior Stance

## When this applies
Load when task touches HTTP/RPC endpoints, GraphQL schema, gRPC proto, OpenAPI spec, route handlers, or anything that's a public contract between services / between frontend and backend / between teams. Reviewer auto-loads when diff includes `routes/`, `controllers/`, `*.proto`, `openapi.yaml`, GraphQL `*.graphql` / resolvers, or new public-facing functions.

## Default Stance
The signature you ship is the signature you live with. Internal code can refactor freely; public contracts are forever-ish. Spend more time on shape than on implementation. Idempotency, pagination, errors, versioning — design these explicitly before the first request hits prod. Default to boring REST until you have a concrete reason for GraphQL or gRPC.

## Patterns (use these)

### Resource modeling
- Nouns, not verbs: `POST /users` to create, not `POST /createUser`.
- Hierarchy when entities truly nest: `/users/{id}/orders/{order_id}`. Stop nesting at 2 levels — `/a/{}/b/{}/c/{}/d/{}` becomes unreadable and inflexible.
- Plural collections: `/users` returns many, `/users/{id}` returns one.
- Filtering via query: `GET /users?status=active&created_after=2026-01-01`. Avoid `POST /users/search` with body unless you need huge filters that don't fit URL.

### Idempotency keys
Every state-mutating endpoint accepts `Idempotency-Key` header (or body field). Server stores `(key → response)` for 24h. Replay of same key returns the cached response, NOT a duplicate write. This is the single most-important defense against duplicate writes from retries/network blips.

### Pagination patterns
- **Cursor-based** (preferred for large/changing collections): `?cursor=eyJ...&limit=50`. Stable under inserts, indexable, no offset cost.
- **Page-based** OK for stable small datasets: `?page=2&size=50`. Simple but breaks under concurrent inserts.
- **NEVER unbounded**: every list endpoint has a default limit and a max limit. Reject `limit > max` with 400.

### Versioning
- **URL versioning** (`/v1/users`, `/v2/users`) — clearest, easiest to route, easiest for caches.
- **Header versioning** (`Accept: application/vnd.foo.v2+json`) — cleaner URLs but invisible to logs/CDN.
- For internal APIs, version-on-spec-change is fine. For public APIs, version-on-breaking-change only — additive changes (new optional field) don't warrant a new major.
- Document the deprecation timeline. Sunset old versions on a calendar, not "when we feel like it".

### Error envelope (consistent shape)
Every error response has the same shape:
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
- `code` is machine-parseable, stable, SCREAMING_SNAKE_CASE.
- `message` is human-readable, may be localized.
- `details` is structured per error type; clients can opt-in to handle.
- `request_id` echoes back from logs for debugging.

### HTTP status code discipline
- `200` — success with body.
- `201` — created (POST returning a new resource), include `Location` header.
- `204` — success, no body (DELETE, void mutations).
- `400` — client sent malformed/invalid input. Body explains.
- `401` — not authenticated.
- `403` — authenticated but not authorized.
- `404` — resource doesn't exist OR you don't want to leak that it does (auth-by-existence).
- `409` — conflict (idempotency-key reuse, optimistic-lock failure, unique constraint).
- `422` — semantically valid but unprocessable (validation rules failed). Some teams use `400` for this; pick one and stay consistent.
- `429` — rate limited. Include `Retry-After` header.
- `5xx` — server's fault. Don't leak stack traces.

### Rate limiting
- Per-user (authenticated) AND per-IP (unauthenticated).
- Token bucket via `redis-cell` or equivalent. Document limits in API docs.
- Return `429` with `Retry-After: <seconds>` and `X-RateLimit-Remaining: <n>` headers.
- Different limits per endpoint based on cost (cheap reads vs expensive computes).

### Auth at the edge
- Validate token at the API gateway / first middleware. Internal services trust the validated context.
- Don't mix authn (who are you) and authz (what can you do). Authn produces a principal; authz checks the principal against the resource per request.
- Time-box tokens. JWT exp ≤ 1 hour, refresh tokens longer with revocation.

### REST vs GraphQL vs gRPC

| Need | Default |
|---|---|
| Public API for humans/external | REST + OpenAPI |
| Internal service-to-service, low latency, strong typing | gRPC |
| Frontend with widely-varying data needs | GraphQL — only if you're paying the operational cost |
| Real-time bidirectional | WebSocket / gRPC streaming |

Don't pick GraphQL because it's trendy. Operational cost (N+1, query depth limits, auth-per-field, persisted queries, schema evolution, caching) is real. REST + a few well-chosen aggregating endpoints often wins.

## Anti-Patterns (DO NOT)

### `POST /verb` instead of `POST /resource`
**Why it bites:** `POST /createUser`, `POST /updateUser`, `POST /deleteUser` — you've reinvented RPC over HTTP, lost all REST conventions (caching, methods, status codes). Tools, gateways, CDNs assume REST shape.
**Rule:** Use HTTP methods for verbs. `POST /users` to create, `PATCH /users/{id}` to update, `DELETE /users/{id}` to delete.

### Returning everything always
`GET /users` returns full user with addresses, preferences, audit log embedded.
**Why it bites:** payload sizes balloon, mobile clients pay for bytes they don't render, evolving the response shape breaks consumers. Privacy: you may leak fields.
**Rule:** lean default response. Use `?fields=` or `?include=addresses` for opt-in expansion.

### No idempotency on writes
**Why it bites:** retry storm = N duplicate writes. Mobile network blip = duplicate charge. Distributed clients without idempotency keys is a guaranteed prod incident.
**Rule:** every mutating endpoint accepts `Idempotency-Key`, server enforces it.

### Inconsistent error shapes
`POST /a` returns `{"error": "..."}`, `POST /b` returns `{"errors": [...]}`, `POST /c` returns `"failed"`. Frontend has 5 error parsers.
**Rule:** one error envelope for the whole API.

### Breaking changes without versioning
Renaming `userName` → `user_name`, removing a field, changing types — all without a version bump.
**Rule:** breaking change = new major. Old version stays until sunset date. Communicate via deprecation header `Deprecation: <date>` and `Sunset: <date>`.

### Exposing internal IDs / database structure
`GET /users/42` where `42` is the autoincrement DB primary key.
**Why it bites:** id leaks user count, sequencing reveals signup velocity, easy to enumerate. Internal refactor (DB swap, sharding) breaks contract.
**Rule:** opaque identifiers (UUID v7, ULID, or surrogate slug). DB id stays internal.

### Hidden state in query params
`GET /users?limit=50&filter[status]=active&sort[name]=asc&include=addresses,roles&fields=id,name,email&page=3...`
Six concepts in URL, parsing nightmare, no schema validation.
**Rule:** if a "list" endpoint has > 4 query params, design a structured filter type or split into multiple endpoints.

### `200 OK` with `{"error": ...}` body
Failed but returned 200. Frontend has to parse body to know if it succeeded. CDN caches the "error" response.
**Rule:** HTTP status reflects success/failure. `4xx` for client errors, `5xx` for server errors. Always.

### Returning partial success silently
Bulk endpoint accepts 100 items, succeeds for 87, fails for 13, returns 200 with no breakdown.
**Rule:** explicit per-item result array, OR fail the whole request, OR use `207 Multi-Status` with per-item details.

### Versioning everything as v1 forever
Adding optional fields, deprecating old ones, but never bumping the version. After 2 years, "v1" looks nothing like the original.
**Rule:** name versions honestly. Or use header-based versioning with explicit deprecation.

### CORS wildcard with credentials
`Access-Control-Allow-Origin: *` AND `Access-Control-Allow-Credentials: true` — browsers reject this anyway, but seeing it in code = misconfigured intent.
**Rule:** explicit origin allowlist; never `*` with credentials.

## Decision Framework

| Situation | Choice |
|---|---|
| Mutating endpoint | POST/PUT/PATCH + idempotency key |
| Listing changing collection | Cursor pagination |
| Listing stable small set | Page/size pagination acceptable |
| Need to filter on 5+ axes | Reconsider — split endpoints, or POST /search with structured body |
| Bulk operation | Limit batch size; return per-item status array |
| Long-running operation | `202 Accepted` + `Location: /jobs/{id}` polling, OR webhook on completion |
| Sensitive update | Require fresh auth (re-auth or step-up) |
| Adding new optional field | Minor version (or no bump) |
| Removing/renaming/changing type | Major version, deprecation timeline |
| Internal vs external API | More flexibility internally; stricter discipline externally |

## Cost Model

| Decision | Cost when wrong |
|---|---|
| No idempotency key | Duplicate writes from retry storm; fix is per-endpoint, takes weeks per service |
| `OFFSET` pagination on big tables | Page 1000 = 50ms → 5s as data grows; users see "loading…" forever |
| Status code wrong | Client error handlers get fragile, observability dashboards mislead |
| Breaking change without version | Every consumer breaks at deploy time; rollback may take hours |
| Exposing internal DB id | One refactor away from leaking implementation; can't easily migrate to sharding |
| `Cache-Control: public` on per-user data | Privacy incident, cross-user data leak |

## Red Flags in Diff

- New endpoint missing `Idempotency-Key` handling on POST/PUT/PATCH → flag.
- New list endpoint without `limit` or with no max-limit enforcement → flag.
- New error response not matching the project's error envelope shape → flag.
- New endpoint reusing an existing version (`/v1/...`) but adding a breaking change → flag major-bump needed.
- `POST /api/<verb>` style introduced when project uses RESTful nouns → flag.
- Internal DB primary key (autoincrement integer) exposed in a response → flag.
- New endpoint returning `200` on logical failure → flag.
- Bulk endpoint without per-item result array → flag.
- New 5xx code being returned for client-side validation errors → flag.
- CORS config allowing wildcard origin AND credentials → flag immediately.
- New endpoint without rate-limit middleware → flag if it's potentially expensive (DB writes, computes, external calls).
- Response payload includes fields not declared in the project's API spec / OpenAPI doc → flag (drift).
