// Barrel for the state-core modules. Public callers import from
// `@loom/kernel` (which re-exports this file via the package root
// barrel); kernel-internal modules may import from `./state.js` for
// brevity. The split mirrors the types/ layout — one topic per file.
//
//   ./state/db.ts            openDb / closeDb / migration runner,
//                            KernelError, captureNow
//   ./state/transaction.ts   TransactionImpl + withStateTransaction
//   ./state/load.ts          loadState materializer

export { KernelError, captureNow, closeDb, openDb } from "./state/db.js";
export { TransactionImpl, withStateTransaction } from "./state/transaction.js";
export { loadState } from "./state/load.js";
