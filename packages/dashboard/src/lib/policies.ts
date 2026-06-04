// The supervision policy presets a task can be submitted under — the SAME set
// the CLI and the prior console exposed, passed verbatim as `policy_preset` on
// `POST /submit`. The empty value means "the bundle's own default policy"; the
// server interprets each name, so this list is a thin UI affordance, not a
// source of policy meaning. Domain-blind: these are generic supervision modes
// (which gates pause for a human), not a bundle's gate vocabulary.

export interface PolicyPreset {
  value: string;
  label: string;
}

export const POLICY_PRESETS: readonly PolicyPreset[] = [
  { value: "", label: "(bundle default)" },
  { value: "full-autonomous", label: "full-autonomous (all gates auto)" },
  { value: "gates-on-blockers", label: "gates-on-blockers" },
  { value: "review-plan-only", label: "review-plan-only (plan gate human)" },
  { value: "review-final-only", label: "review-final-only (final gate human)" },
  { value: "full-supervised", label: "full-supervised (all gates human)" },
];
