// Vocabulary<T> — open-enum primitive.
//
// Seven places in the kernel use the same pattern: kernel-shipped
// baseline + bundle-supplied extensions + insert-time validation.
// `Vocabulary<T>` makes this a typed primitive instead of a documented
// convention. Frozen after registry load; running code never mutates
// an instance. Bundle hot-swap (deferred) would rebuild the registry.

import type { Bundle } from "./bundle.js";
import type { AgentOutputKind } from "./plugins.js";
import type { GateDecidedBy, GateRole } from "./row-types.js";

export interface Vocabulary<T extends string = string> {
  readonly kernel_defaults: ReadonlySet<T>;
  readonly bundle_extensions: ReadonlySet<T>;
  // Union, precomputed.
  readonly all: ReadonlySet<T>;
  // Insert-time predicate. False → caller refuses with `code:"VOCAB_UNKNOWN"`.
  has(value: string): value is T;
}

// Kernel-owned vocabularies registered at registry load. Every site
// that previously used "open string + bundle-merge + insert-time
// validation" reads from this map. New vocabularies extend the
// interface (additive, no migration).
export interface KernelVocabularies {
  // `audit.type` column values.
  audit_types: Vocabulary<string>;
  // `agent_records.output_kind` values.
  output_kinds: Vocabulary<AgentOutputKind>;
  // `gates.decided_by` values; kernel ships "human" | "auto-policy".
  decided_by: Vocabulary<GateDecidedBy>;
  // `error_class` registry across audit + idempotency-ledger.
  error_classes: Vocabulary<string>;
  // Sandbox kinds (`SandboxPlugin.kind`).
  sandbox_kinds: Vocabulary<string>;
  // Provider feature flags (`ProviderCapabilities.features`).
  provider_features: Vocabulary<string>;
  // Gate roles.
  gate_roles: Vocabulary<GateRole>;
}

// Construction (kernel-internal, called once at registry load).
export declare function buildVocabularies(bundle: Bundle): KernelVocabularies;
