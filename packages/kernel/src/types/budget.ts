// Budget — three-axis discriminated union.
//
// Earlier drafts overloaded one `Budget` interface across nine call
// sites that tracked different dimensions (wall-time, attempt counts,
// row counts). This ships three disjoint types — one per dimension —
// unified through a `kind`-discriminated `Budget` union. Each call
// site declares which axis it bounds; loader rejects budgets whose
// `kind` is wrong for the call site.

interface BudgetBase {
  // When true the kernel-shipped default is inviolable; bundle YAML
  // cannot override (loader rejects with `code:"BUDGET_INVIOLABLE"`).
  inviolable?: boolean;
  on_exhaustion: "human" | "audit-only" | "abandon";
}

export interface TimeBudget extends BudgetBase {
  kind: "time";
  timeout_ms: number;
  kernel_ceiling_ms?: number;
}

export interface AttemptBudget extends BudgetBase {
  kind: "attempt";
  max_iterations: number;
  kernel_ceiling?: number;
}

export interface ResourceBudget extends BudgetBase {
  kind: "resource";
  max_count: number;
  kernel_ceiling?: number;
}

export type Budget = TimeBudget | AttemptBudget | ResourceBudget;
