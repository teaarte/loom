---
tags: [nextjs, app-router, rsc, route-handlers, layouts, frontend]
stack_signals:
  - language: [typescript, javascript]
  - project_type: [frontend-app, monorepo]
summary: |
  Next.js App Router stance — Server Components by default, Client only where
  needed, layered cache (data/route/full-route/edge) decided per route. Each
  file convention has a specific contract; mixing them creates subtle bugs.
when_to_load: |
  Project uses Next.js ≥13 with App Router (app/ directory, not pages/).
  Diff includes files under app/, 'use client'/'use server' directives,
  loading.tsx, error.tsx, not-found.tsx, route.ts, layout.tsx, revalidate,
  cacheTag, cacheLife, parallel/intercepted routes, or middleware.
agent_hints: [logic-reviewer, performance, ui-consistency, api-contract]
---

# Next.js App Router — Senior Stance

## When this applies
Load when project uses Next.js ≥13 with App Router (`app/` directory, not `pages/`). Reviewer auto-loads when diff includes files under `app/`, `'use client'`/`'use server'` directives, `loading.tsx`, `error.tsx`, `not-found.tsx`, `route.ts`, `layout.tsx`, `revalidate`, `cacheTag`, `cacheLife`, parallel/intercepted routes, or middleware. Complements `react19.md` (which covers RSC primitives) — this file is router-specific.

## Default Stance
The App Router collapses concerns that used to live in separate places (data fetching, caching, layouts, error boundaries, middleware, route handlers). Each file convention has a specific contract; mixing them creates subtle bugs. Default to Server Components; mark Client only where you actually need it. Cache behavior is layered (data cache, route cache, full route cache, edge cache) — make caching decisions explicit per route, not by default.

## Patterns (use these)

### File conventions — know what each does
- `page.tsx` — the route's UI. Default Server Component.
- `layout.tsx` — wraps pages in this segment. Persists across navigation. Default Server Component.
- `template.tsx` — like layout but re-renders on navigation. Use when state should reset.
- `loading.tsx` — Suspense fallback for the route. Auto-wraps the page.
- `error.tsx` — error boundary for the route. Must be Client Component.
- `not-found.tsx` — rendered for `notFound()` calls.
- `route.ts` (or `route.js`) — HTTP handler. Cannot coexist with `page.tsx` in same segment.
- `middleware.ts` — runs before request, at the edge.

### Server Components by default
A new component is a Server Component unless you mark it `'use client'`. Server Components:
- Run only on the server, never ship to the browser.
- Cannot use hooks (`useState`, `useEffect`, `useRef`, etc.).
- Can be `async` and fetch data directly.
- Cannot pass non-serializable values (functions, classes) to Client Components.

### Client Components — at the leaves
- `'use client'` directive at top of file.
- Mark only what needs interactivity / browser APIs / hooks.
- Wrap a small interactive piece, leave the rest Server.
- Server Components can render Client Components, AND can pass them children prop (slot pattern) — Client renders its slot Server-rendered content.

### Data fetching: where and how
- **Server Components**: `await fetch(...)` directly in the component. Next dedupes identical fetches per request, caches per default policy.
- **Server Actions**: `'use server'` functions. Can be invoked from Client Components for mutations. Auth check at the top.
- **Route Handlers** (`route.ts`): for non-RSC consumers — webhooks, JSON APIs, third-party callbacks.
- **Client Components**: still use TanStack Query / SWR for client-side data needs (real-time, optimistic, complex caching).

### Caching layers (Next 14+)
Four layers, each with different invalidation:
1. **Request Memoization** — per-request dedupe of identical fetches. Automatic.
2. **Data Cache** — persistent across requests. `fetch` with `next: { revalidate: N }` or `cache: 'no-store'`.
3. **Full Route Cache** — pre-rendered HTML + RSC payload. Static by default; opt out with dynamic functions (`cookies()`, `headers()`, `searchParams`).
4. **Router Cache** — client-side, in-memory, soft-navigation cache.

Invalidation: `revalidatePath()`, `revalidateTag()`, `revalidate` time-based.

In Next 16 (Cache Components): `'use cache'` directive + `cacheLife` / `cacheTag`. New PPR (Partial Prerendering) model. If you're on 16, see those primitives — different from 14/15 cache.

### Server Actions: secured at the function
```ts
'use server';
export async function deletePost(formData: FormData) {
  const session = await getServerSession();
  if (!session) throw new Error('unauthorized'); // NEVER skip
  // ... rest
}
```
- Auth check at top of EVERY action body.
- Validate inputs with a schema (Zod). FormData is untyped.
- Don't return huge data. Return success flag, errors, redirect target.

### Loading + Error UX
- Co-locate `loading.tsx` and `error.tsx` per route segment.
- `loading.tsx` is wrapped in `<Suspense>` automatically — granular suspense by route.
- `error.tsx` MUST be `'use client'`. Receives `error` and `reset` props.
- `notFound()` → renders nearest `not-found.tsx`.

### Streaming + Suspense
- Page can be partially streamed: layout renders first, slow data Suspends, finishes streaming when ready.
- Place `<Suspense>` around slow data sources. Loading UI shows while waiting.
- One coarse Suspense around everything → users wait for slowest piece. Multiple fine Suspense → progressive reveal.

### Parallel and Intercepted Routes
- **Parallel** (`@slot/page.tsx`): render multiple pages in same layout simultaneously. Use for dashboards with independent regions.
- **Intercepted** (`(.)foo`, `(..)foo`): show one route in the context of another (e.g., photo modal over feed). Browser refresh shows full route.
- Powerful, but increases mental load. Use only when payoff is clear.

### Middleware
- Runs on every matching request at the Edge runtime.
- Auth checks, redirects, A/B routing.
- Cannot do heavy work — runs on every request.
- Use `matcher` config to limit which routes run middleware.

### Generating routes
- `generateStaticParams` for static generation.
- `dynamic = 'force-dynamic'` to opt out.
- `revalidate = 60` for ISR-like behavior.
Set explicitly per route — defaults change between Next versions.

## Anti-Patterns (DO NOT)

### `'use client'` on the root layout
Marks ENTIRE app tree as Client. You lose all Server Component benefits.
**Rule:** layout stays Server. Wrap interactive children in their own Client components.

### Big `'use client'` boundary at the top of a route
Page is mostly server-renderable but one button needs `onClick` → marking the whole page Client → entire tree shipped to browser.
**Rule:** isolate the interactive piece. Server page → renders Client button only.

### Server Action without auth check
**Why it bites:** action is callable directly via fetch from anywhere — components are not security boundaries.
**Rule:** every Server Action begins with explicit auth check. (Repeated from react19.md because it's the #1 issue.)

### Reading `request` / cookies in a layout that's static
Layout uses `cookies()` → entire route segment opts out of static rendering → unexpectedly dynamic.
**Rule:** know what you're opting out of. If you need cookies, accept the dynamic cost; if not, isolate the cookie use.

### `fetch` without `cache` option, then surprised by stale data
Default cache behavior changes between Next versions and per-route. Implicit defaults bite you.
**Rule:** explicit `cache: 'force-cache' | 'no-store'` and `next: { revalidate: N, tags: [...] }` per fetch. Don't rely on memory of defaults.

### Mutation in Server Component
```ts
async function Page() {
  await deletePost(id); // BAD
  return <div>...</div>;
}
```
Server Components are GET-equivalent. Mutations go through Server Actions (POST) or route handlers.
**Rule:** mutation paths use Server Actions or route handlers. Server Components only read.

### Shared `'use client'` utility with re-exports
File marked Client, re-exports a Server-only function. Imports cross the boundary in unexpected ways.
**Rule:** keep Client and Server utility files separate. Import boundary follows directive boundary.

### `error.tsx` not marked Client
File is Server Component (default), but error boundaries must be Client. Build fails or runtime error occurs.
**Rule:** `error.tsx` always starts with `'use client'`.

### One coarse `<Suspense>` wrapping everything
Slowest data source dictates user-visible wait time. No streaming benefit.
**Rule:** Suspense at meaningful UI region boundaries (sidebar, main, footer, slow card).

### Middleware doing DB / heavy work
Middleware fires per request at the edge → can't reach app DB cheaply, adds 50-200ms per request.
**Rule:** middleware = lightweight redirects/auth checks. Heavy work in route handlers.

### `searchParams` used in static page
Page uses `searchParams` → forces dynamic rendering → no static optimization → slower TTFB.
**Rule:** know that `searchParams` is dynamic. Either accept dynamic, or use `generateStaticParams` for known param sets.

### Returning JSX from Server Action
Server Actions return data; UI is rendered by the page or component on response.
**Rule:** action returns plain JSON-serializable data. Component re-renders with that data.

### `revalidate: 0` everywhere "to be safe"
Defeats Next's caching, every request hits backing source.
**Rule:** pick TTL based on data freshness needs.

### Calling Client-only APIs inside Server Component
`window`, `document`, `localStorage` — runtime error or build error.
**Rule:** access via `'use client'` boundary only. Use `useEffect` for browser APIs.

### Imports from Client Component into Server Component creating cycles
Client Component imports from a server-only module; server-only module imports from a Client Component. Bundler chokes or duplicates code.
**Rule:** clean dependency tree. Server depends on Server; Client may depend on Client + serializable Server exports.

### Migrating Pages Router incrementally without strategy
Keeping `pages/` and `app/` simultaneously, sharing components without checking which directives propagate.
**Rule:** plan migration per-segment. Don't expect Pages Router middleware/_app to apply to App Router routes.

## Decision Framework

| Need | Choice |
|---|---|
| Read DB and render | Server Component with `await` |
| Form submit | Server Action + `useActionState` |
| Optimistic UI | `useOptimistic` (Client Component, see react19.md) |
| Public JSON API | Route handler `route.ts` |
| Webhook receiver | Route handler with signature verification |
| Auth redirect | Middleware (lightweight) or in layout/page |
| Real-time data | Client Component + WebSocket / SSE / polling |
| Slow data + fast layout | Suspense around slow part; layout renders first |
| Data shared across pages | Layout component fetches; pages receive via children render |
| Mutating data + revalidating | Server Action calls `revalidatePath` / `revalidateTag` |
| Static page with occasional updates | `revalidate: N` (ISR) |
| Per-user dynamic page | `dynamic = 'force-dynamic'` or use of cookies/headers |
| Multiple regions in a dashboard | Parallel routes (`@slot`) |
| Modal that's also a real route | Intercepted routes |

## Cost Model

| Pattern | Cost / Win |
|---|---|
| Server Component | 0 client JS for that component |
| `'use client'` on a leaf | +5-30KB JS bundle for that island |
| `'use client'` on root layout | Entire app shipped to browser |
| Server Action call | 1 round trip + serialization |
| Static route (full prerender) | Sub-100ms TTFB from CDN |
| `dynamic = 'force-dynamic'` | Every request hits the server; TTFB depends on backing data |
| ISR with revalidate=60 | First request after 60s rebuilds; users see brief stale |
| Middleware on every route | +5-50ms per request at the edge |
| Coarse Suspense | Wait for slowest data → entire page blocked |
| Granular Suspense | Progressive reveal; better perceived perf |

## Red Flags in Diff

- `'use client'` added to `app/layout.tsx` or any top-level layout → flag (massive bundle impact).
- `'use client'` added to a component without any hooks / event handlers / browser APIs → flag (probably can stay Server).
- Server Action without explicit auth check at top of body → flag immediately.
- New `error.tsx` not starting with `'use client'` → flag.
- New `fetch(...)` in Server Component without explicit `cache` / `next.revalidate` config → flag (implicit-default risk).
- `cookies()` / `headers()` used in a layout that's expected to be static → flag (forces dynamic render of all child pages).
- Server Action returning JSX or a class instance → flag (must be JSON-serializable).
- New middleware doing DB / heavy work → flag.
- Whole route or page wrapped in single `<Suspense>` → flag (no streaming benefit).
- `revalidate: 0` everywhere → flag (caching defeated).
- New `searchParams` use in a page expected to be statically generated → flag.
- Server Component file imports from a `'use client'` file and uses non-serializable export → flag.
- Route handler `route.ts` AND `page.tsx` in same segment → flag (illegal).
- `redirect()` inside Server Action without idempotency consideration → flag.
- New parallel/intercepted route without `default.tsx` for the parallel slot when no match → flag (will crash).
