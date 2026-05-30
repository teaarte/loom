---
tags: [performance, react, nextjs, rendering, bundle, hydration, frontend]
stack_signals:
  - language: [typescript, javascript]
  - project_type: [frontend-app, monorepo]
summary: |
  React/Next.js performance checklist — unnecessary re-renders, heavy
  build/render paths, bundle bloat, hydration mismatches, asset
  optimization, App Router server/client boundary choices.
when_to_load: |
  Task touches React/Next.js components, hooks, rendering perf, bundle size,
  image/font loading, or Next.js-specific perf concerns (revalidate, ISR,
  Server vs Client components). Reviewer fan-out includes performance
  or UI-consistency on a React/Next stack.
agent_hints: [performance, logic-reviewer, ui-consistency]
---

# Performance: React / Next.js

## Rendering
- Unnecessary re-renders (missing memo/useMemo/useCallback where it matters)
- Heavy computations in render path — move to useMemo or outside component
- Context provider placed too high — causes cascading re-renders in unrelated subtrees
- State lifted too high when it could be local (colocate state with consumers)
- Large inline objects/arrays in JSX — creates new references every render, defeats React.memo
- Key prop misuse — using array index as key in dynamic lists causes unnecessary unmount/remount
- useEffect with unstable dependencies (object/array refs) running every render

## Data Fetching
- Client-side data fetching that could be server-side (SSR/SSG)
- Missing React Query / SWR deduplication for same endpoint called from multiple components
- Hydration mismatch causing full client-side re-render

## Bundle & Loading
- Large new dependencies added to bundle (check with bundlephobia)
- Missing lazy loading for heavy routes/components (`React.lazy` / `next/dynamic`)
- Missing virtualization for long lists (50+ items) — use react-window/react-virtual
- Missing debounce/throttle on frequent events (search input, scroll, resize)

## Assets
- Unoptimized images (missing `next/image`, no width/height, no srcset)
- Missing font loading strategy (`next/font` or `font-display: swap`)
- Third-party scripts loaded synchronously — use `next/script` with `strategy="lazyOnload"`

## Next.js Specific
- Using client components where server component would suffice
- Missing `revalidate` on ISR pages (stale data served indefinitely)
- `getServerSideProps` where `getStaticProps` + revalidate would work
- Not using Route Handlers / Server Actions for mutations (unnecessary client-side fetch)

## Note
React 19 compiler (React Forget) auto-memoizes — manual useMemo/useCallback may become less critical. Still flag missing memoization but note this.
