// Kernel-enforced absolute ceilings for the tunables a bundle may set.
//
// Bundle YAML / TS may declare a `replan_budget.max_iterations` lower
// than the ceiling here, but never higher: `min(bundle.replan_budget.
// max_iterations, KERNEL_BUDGET_CEILINGS.replan)` is the effective cap
// the gate-policy dispatcher enforces. The ceiling exists because a
// runaway loop with `auto-reject` policy + unbounded `max_iterations`
// would silently spin the FSM forever; a hard kernel cap forces the
// exhaustion branch to fire even if a bundle author forgets to tune.
//
// `fanout_concurrency_global` is the forward-declared sibling ceiling
// the spawn-batch path will read once concurrency-bounded fanout
// lands. Kept here so both ceilings share one home.

export const KERNEL_BUDGET_CEILINGS = Object.freeze({
  replan: 10,
  fanout_concurrency_global: 8,
});
