// Barrel re-export of the kernel type surface.
//
// Source modules are organized by topic:
//   now.ts            — NowToken (replay-safe wall-clock)
//   vocabulary.ts     — open-enum primitive + kernel vocabulary map
//   row-types.ts      — Phase / gate / verdict row shapes + StackInfo
//   state.ts          — PipelineState + BundleStateView projection
//   policy.ts         — gate-policy primitive + context + result
//   user-answer.ts    — gate reply protocol + answer schema
//   findings.ts       — Finding + severity / status vocab
//   invariants.ts     — Violation + Invariant + KernelSnapshots
//   budget.ts         — three-axis discriminated Budget union
//   idempotency.ts    — IdempotencyKey + op tag + ledger row
//   agent-result.ts   — AgentResult / AgentRecord / parse errors
//   transport.ts      — KernelDirective + TransportResponse + adapter
//   provider.ts       — ProviderResult cluster + LLMProvider forward decl
//   continue-task.ts  — `pipeline_continue_task` payload variants
//   tool.ts           — ToolDefinition + output-compression policy
//   bundle.ts         — Bundle aggregate
//   extension.ts      — ExtensionManifest + PromptTemplate
//   context.ts        — StageContext / HookContext / BundleScratchTx
//   registry.ts       — Registry + ProviderRegistry
//   transaction.ts    — kernel-internal Transaction + AuditEntry
//   plugins.ts        — non-LLM plugin-contract forward decls

export * from "./now.js";
export * from "./vocabulary.js";
export * from "./row-types.js";
export * from "./state.js";
export * from "./policy.js";
export * from "./user-answer.js";
export * from "./findings.js";
export * from "./invariants.js";
export * from "./budget.js";
export * from "./idempotency.js";
export * from "./agent-result.js";
export * from "./transport.js";
export * from "./provider.js";
export * from "./continue-task.js";
export * from "./tool.js";
export * from "./bundle.js";
export * from "./extension.js";
export * from "./context.js";
export * from "./registry.js";
export * from "./transaction.js";
export * from "./plugins.js";
