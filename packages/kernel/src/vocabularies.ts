// `buildVocabularies(bundle)` — materializes the kernel-additive enum
// surface at registry load.
//
// Each `Vocabulary<T>` instance holds three frozen sets: the kernel
// baseline (whatever the substrate ships emit-sites for), the bundle's
// declared extensions (from `Bundle.extends_vocab`), and the precomputed
// union. Insert-time predicates fall out of `all.has(value)`; running
// code never mutates an instance, and a bundle hot-swap (deferred)
// would rebuild the registry, not patch in place.
//
// Per-insert `.has()` wiring at every kernel write site is a separate
// concern — this layer constructs the merged sets and exposes them on
// the Registry; the consumers (audit insert, finding insert, gate
// decision recorder, etc.) gain runtime validation in a follow-up.
//
// Sunset contradiction is refused here: a value that the bundle both
// declares in `extends_vocab.<kind>` AND retires via
// `extends_vocab.sunset[]` cannot mean both "currently valid" and
// "historical-only" in the same version, so the loader fails fast.

import { KernelError } from "./state/db.js";
import type { Bundle } from "./types/bundle.js";
import type { AgentOutputKind } from "./types/plugins.js";
import type { GateDecidedBy, GateRole } from "./types/row-types.js";
import type { KernelVocabularies, Vocabulary } from "./types/vocabulary.js";

// ============================================================================
// Kernel baselines
// ============================================================================

// The audit-type strings the kernel itself emits today. Bundles extend
// via `Bundle.extends_vocab.audit_types`; new kernel emit-sites add to
// this set.
const KERNEL_AUDIT_TYPES: readonly string[] = [
  "hook-failure",
  "extension-installed",
  "extension-manifest-changed",
  "extension-removed",
  "extension-load-failed",
  "tool-call",
];

const KERNEL_OUTPUT_KINDS: readonly AgentOutputKind[] = [
  "reviewer",
  "validator",
  "nonreview",
  "classifier",
];

const KERNEL_DECIDED_BY: readonly GateDecidedBy[] = ["human", "auto-policy"];

const KERNEL_ERROR_CLASSES: readonly string[] = [
  "hook-failure",
  "extension-load-failed",
  "sandbox-violation",
  "tool-output-compressed",
];

const KERNEL_SANDBOX_KINDS: readonly string[] = [
  "path-restricted",
  "passthrough",
];

const KERNEL_PROVIDER_FEATURES: readonly string[] = [];

const KERNEL_GATE_ROLES: readonly GateRole[] = ["classify", "plan", "final"];

// ============================================================================
// Sunset entry — typed projection of bundle.extends_vocab.sunset[]
// ============================================================================

interface SunsetEntry {
  kind: string;
  value: string;
}

function readSunsetEntries(bundle: Bundle): SunsetEntry[] {
  const ev = bundle.extends_vocab as unknown as Record<string, unknown> | undefined;
  if (ev === undefined) return [];
  const sunset = ev["sunset"];
  if (!Array.isArray(sunset)) return [];
  const out: SunsetEntry[] = [];
  for (const raw of sunset) {
    if (typeof raw !== "object" || raw === null) continue;
    const obj = raw as Record<string, unknown>;
    const kind = obj["kind"];
    const value = obj["value"];
    if (typeof kind !== "string" || typeof value !== "string") continue;
    out.push({ kind, value });
  }
  return out;
}

// ============================================================================
// Builder
// ============================================================================

function makeVocabulary<T extends string>(
  defaults: readonly T[],
  extensions: readonly T[],
): Vocabulary<T> {
  const kernel = new Set<T>(defaults);
  const bundleExt = new Set<T>(extensions);
  const union = new Set<T>([...kernel, ...bundleExt]);
  const all = union as ReadonlySet<T>;
  return {
    kernel_defaults: kernel as ReadonlySet<T>,
    bundle_extensions: bundleExt as ReadonlySet<T>,
    all,
    has(value: string): value is T {
      return (all as ReadonlySet<string>).has(value);
    },
  };
}

function refuseSunsetContradiction(
  bundle: Bundle,
  kind: string,
  extensions: readonly string[],
  sunset: readonly SunsetEntry[],
): void {
  const ext = new Set(extensions);
  for (const s of sunset) {
    if (s.kind !== kind) continue;
    if (ext.has(s.value)) {
      throw new KernelError({
        code: "VOCAB_SUNSET_CONTRADICTION",
        message:
          `bundle '${bundle.name}' declares '${s.value}' as both an active ` +
          `${kind} extension and a sunset entry`,
        detail: { bundle: bundle.name, kind, value: s.value },
      });
    }
  }
}

export function buildVocabularies(bundle: Bundle): KernelVocabularies {
  const ev = bundle.extends_vocab ?? {};
  const sunset = readSunsetEntries(bundle);

  const auditExt = ev.audit_types ?? [];
  const outputExt = (ev.output_kinds ?? []) as readonly AgentOutputKind[];
  const errorExt = ev.error_classes ?? [];
  const gateExt = (ev.gate_roles_extra ?? []) as readonly GateRole[];

  refuseSunsetContradiction(bundle, "audit_types", auditExt, sunset);
  refuseSunsetContradiction(bundle, "output_kinds", outputExt as readonly string[], sunset);
  refuseSunsetContradiction(bundle, "error_classes", errorExt, sunset);
  refuseSunsetContradiction(bundle, "gate_roles_extra", gateExt as readonly string[], sunset);

  return {
    audit_types: makeVocabulary<string>(KERNEL_AUDIT_TYPES, auditExt),
    output_kinds: makeVocabulary<AgentOutputKind>(KERNEL_OUTPUT_KINDS, outputExt),
    decided_by: makeVocabulary<GateDecidedBy>(KERNEL_DECIDED_BY, []),
    error_classes: makeVocabulary<string>(KERNEL_ERROR_CLASSES, errorExt),
    sandbox_kinds: makeVocabulary<string>(KERNEL_SANDBOX_KINDS, []),
    provider_features: makeVocabulary<string>(KERNEL_PROVIDER_FEATURES, []),
    gate_roles: makeVocabulary<GateRole>(KERNEL_GATE_ROLES, gateExt),
  };
}
