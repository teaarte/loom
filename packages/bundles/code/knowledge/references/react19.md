---
tags: [react, react19, rsc, server-components, server-actions, suspense, frontend]
stack_signals:
  - language: [typescript, javascript]
  - project_type: [frontend-app, monorepo]
summary: |
  React 19 stance — Server Components, Server Actions, use(), useOptimistic,
  useFormStatus, useActionState, Suspense boundaries, React Compiler.
  Delete code that used to be hand-rolled, but don't over-apply primitives.
when_to_load: |
  Project uses react@>=19 (per package.json) or Next.js ≥15 (depends on React
  19). Diff includes Server/Client component boundary changes, Server Actions,
  use() hook, useOptimistic, useFormStatus, useActionState, useTransition,
  Suspense boundaries, or React Compiler annotations.
agent_hints: [logic-reviewer, performance, ui-consistency, challenger-reviewer]
---

# React 19 — Senior Stance

## When this applies
Load when project uses `react@>=19` (check package.json) or Next.js ≥15 (which depends on React 19). Reviewer auto-loads when diff includes Server/Client component boundary changes, Server Actions, `use()` hook, `useOptimistic`, `useFormStatus`, `useActionState`, `useTransition`, Suspense boundaries, or React Compiler annotations.

## Default Stance
React 19 collapses several layers that React 18 made you build by hand: form actions, optimistic updates, async-aware suspension, ref forwarding. The win is "delete code that used to be hand-rolled". The risk is over-applying the new primitives where simpler local state was already correct. Don't refactor working `useState` to `useOptimistic` without a real concurrent-mutation reason. Rename of `forwardRef` is real cleanup; rewriting all forms to Actions is opt-in based on actual benefit.

## Patterns (use these)

### `ref` is now a regular prop (no more `forwardRef`)
React 19 lets function components accept `ref` directly:
```tsx
function Button({ ref, ...props }: ButtonProps & { ref?: React.Ref<HTMLButtonElement> }) {
  return <button ref={ref} {...props} />;
}
```
`forwardRef` still works but is being deprecated. Migrate when touching the file, don't sweep.

### `use()` for reading promises and context conditionally
- `use(promise)` suspends until resolution. Read inside any component, including conditionally (unlike hooks).
- `use(context)` works inside conditionals — the only legal hook-like call inside `if`.
- Cache promises outside render, or use a stable promise source (route loader, parent prop). Creating a new promise inside render = infinite suspend loop.

### `useActionState` for form submissions
Replaces hand-rolled `useState` + `useTransition` + error tracking + pending tracking around form posts.
```tsx
const [state, action, isPending] = useActionState(submitForm, initialState);
return <form action={action}>...</form>;
```
Server Action signature: `async function submitForm(prevState, formData) { ... return newState }`.

### `useOptimistic` for rapid optimistic mutation
Use when **the user makes the same kind of mutation rapidly** (likes, comments, drag-reorder) and visual lag is the dominant UX cost. Returns optimistic state during the action, reverts on failure.
```tsx
const [optimisticItems, addOptimistic] = useOptimistic(items, (state, newItem) => [...state, newItem]);
```
Don't reach for it on rare mutations where a brief loading state is fine.

### `useFormStatus` to read parent form state
Inside a child component nested under a `<form>` — read pending/data/method without prop drilling.
```tsx
function SubmitButton() {
  const { pending } = useFormStatus();
  return <button disabled={pending}>...</button>;
}
```

### Server Actions
`'use server'` directive on a function exposes it as an RPC endpoint. Client can call it directly; React handles serialization and form integration.
- **Validate inputs server-side, always.** `'use server'` is the boundary; client-supplied args are untrusted.
- Auth check **inside** the action body, not in the calling component. Components can be bypassed.
- Sensitive data must not be returned through revalidation paths that may surface in cache layers.

### Server Components
- Server Components run only on server, never ship to client. Default for static and DB-bound content.
- Cannot use hooks (`useState`, `useEffect`) — they're client-only. If you need state, the component is `'use client'`.
- Pass server data to client components via props at the boundary. Don't lift `'use client'` higher than necessary.

### Suspense boundary granularity
Each `<Suspense>` is an independent loading region. Place at the smallest unit where loading has meaning (a single widget, not the whole page). Coarse Suspense boundaries cause whole-screen flashes when one part is slow.

### React Compiler (when adopted)
- Memoizes automatically. **Stop manually wrapping things in `useMemo` / `useCallback`** when compiler is on.
- Verify compiler is on with `// eslint-disable-next-line react-compiler/react-compiler` guard rules.
- Compiler bails out of components with rule violations (impure render, mutating props, etc.). Read compiler logs.

## Anti-Patterns (DO NOT)

### Creating promises inside render
```tsx
// BAD
function Page() {
  const data = use(fetchData()); // new promise every render → infinite suspend
}
```
**Rule:** create the promise outside the component (route loader, server fetch returned as prop) or stable-cache it.

### Server Action without auth check
**Why it bites:** the calling component verifies auth, but the action is callable directly via fetch from anywhere. The component isn't a security boundary.
**Rule:** every Server Action begins with explicit `requireAuth(...)` or equivalent. No exceptions.

### Adding `'use client'` to a component because "it has a button"
**Why it bites:** marking a tree boundary as Client ships it all to the browser. Big perf regression on what should be server-rendered.
**Rule:** isolate the interactive island. Wrap just the button in a Client component, leave the rest Server.

### `useOptimistic` on rare or critical mutations
**Why it bites:** on failure the UI flips back, looks broken; on a payment / save / publish flow the user thinks the action succeeded.
**Rule:** optimistic UI for repetitive low-stakes actions (likes, cart count, drag). Pessimistic with explicit success state for high-stakes.

### Mixing `useState` for form data with `useActionState`
**Why it bites:** two sources of truth, redundant pending tracking, divergent error handling.
**Rule:** pick one. If using `useActionState`, the `state` from it is the form's truth.

### Putting `'use server'` on shared utility files
**Why it bites:** every export becomes a public RPC endpoint. Easy to accidentally expose internal logic.
**Rule:** `'use server'` files contain only intended actions. Internal helpers live in non-`'use server'` files.

### Hand-rolled memoization with React Compiler enabled
**Why it bites:** compiler does it; manual `useMemo` adds noise, can be inconsistent with compiler's analysis, diverges over time.
**Rule:** when compiler is on, delete `useMemo`/`useCallback` unless there's a measured benefit it doesn't cover.

### Returning huge data from Server Action
**Why it bites:** action result is serialized through the wire. 1MB response = slow, may exceed framework limits.
**Rule:** return what the form needs (success flag, errors, redirect target). Refetch heavy data via the page.

### Fine-grained Suspense everywhere
**Why it bites:** every Suspense = a network round trip in some setups, plus visual jank as parts pop in independently.
**Rule:** boundaries match user-meaningful regions. Sidebar, main content, secondary content. Not every component.

### Using async client components
**Why it bites:** client components can't be async. The boundary is server-only.
**Rule:** async function = Server Component. If you need a Client Component, it's sync; data comes via props or `use()`-wrapped promise from parent server.

### Mutating props or state inside render
**Why it bites:** React Compiler bails out → no memoization. React 19 strict mode catches more of these. Was tolerated; now broken.
**Rule:** treat all render inputs as immutable.

## Decision Framework

| Situation | Choice |
|---|---|
| Form submission with server-side logic | Server Action + `useActionState` |
| Optimistic UI for likes/cart-add | `useOptimistic` |
| Optimistic UI for save/publish/payment | Pessimistic + explicit pending |
| Reading async data in a component | Server Component (default) or `use()` in client with stable promise |
| Need state inside what's currently a Server Component | Extract interactive island as Client Component |
| Forwarding ref to a custom component | Direct `ref` prop (not `forwardRef`) |
| Heavy compute in render | Server Component, or `useMemo` if React Compiler off |
| Conditional context read | `use(MyContext)` (legal in conditionals) |
| Pending UI inside form button | `useFormStatus` (no prop drilling) |
| Migrating to compiler-managed memo | Run compiler in opt-in mode first, fix bail-outs, then turn on globally |

## Cost Model

| Pattern | Cost / Win |
|---|---|
| `'use client'` on a leaf | +5-30KB JS bundle for that island |
| `'use client'` on parent of large tree | +entire-tree JS to bundle |
| Server Component | 0 client JS for that component |
| Server Action call | 1 round trip + serialization cost |
| `use(promise)` with stable promise | suspends, no extra round trip if promise is from server |
| `useOptimistic` reverting on error | Visual flip 200-1000ms after action |
| React Compiler enabled | ~5-20% bundle reduction vs hand-memo, fewer re-renders |

## Red Flags in Diff

- `'use client'` added to a component without an interactive primitive (no `onClick`, `useState`, `useEffect`) — flag (probably can stay Server).
- New `forwardRef` in React 19 codebase — flag, prefer direct `ref` prop.
- Server Action without explicit auth check at top of function body — flag immediately (security).
- `use(somePromise())` where `somePromise()` is invoked inline in render — flag (infinite suspend).
- `useOptimistic` on mutation with side-effect failure modes (write to external system, payment) — flag (UX/integrity risk).
- `useState` + `useTransition` + manual error tracking around a form submit — flag (use `useActionState`).
- Async function inside `'use client'` file as a default export → flag (client components can't be async).
- Suspense boundary wrapping the entire page or layout → flag (too coarse).
- `useMemo` / `useCallback` everywhere AND `react-compiler` is on in config → flag (delete the manual ones).
- `'use server'` file exporting non-action utilities → flag (accidental RPC exposure).
- Mutation of props or state object during render → flag (compiler bail-out).
- Server Action returning > 100KB of data → flag (probably should refetch via page).
