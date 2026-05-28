// Host-neutral flag parser. Pulls a single leading `--flag <rest>` off
// the raw task string and resolves it to a named policy preset. Hosts
// that already speak policy_preset directly do not call this — it
// exists so a $ARGUMENTS-style command can be parsed server-side
// instead of every skill markdown re-implementing the same regex.

import type { ParsedTaskArgs } from "../types.js";

export type { ParsedTaskArgs };

// The five recognized leading flags. Order is the registration order
// surfaced by `pipeline_meta.flag_vocabulary` — adding an entry here is
// the single point of edit; the meta tool derives the vocabulary list
// from `Object.keys(FLAG_TO_PRESET)` so parser and discovery surface
// can never drift.
export const FLAG_TO_PRESET: Record<string, string> = {
  "--supervised": "full-supervised",
  "--auto": "full-autonomous",
  "--review-plan": "review-plan-only",
  "--review-final": "review-final-only",
  "--gates-on-blockers": "gates-on-blockers",
};

// Single leading flag: `--name <rest>`. `s` flag preserves newlines
// inside `rest` so multi-line task descriptions round-trip verbatim.
const LEADING_FLAG = /^(--[a-z][a-z-]*)\s+(.+)$/s;

export function parseTaskArgs(raw: string): ParsedTaskArgs {
  const warnings: string[] = [];
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { task: "", warnings };

  const match = LEADING_FLAG.exec(trimmed);
  if (match === null) return { task: trimmed, warnings };

  const flag = match[1] as string;
  const rest = (match[2] as string).trim();

  const preset = FLAG_TO_PRESET[flag];
  if (preset !== undefined) {
    return { task: rest, policy_preset: preset, warnings };
  }

  warnings.push(`unknown-flag: ${flag} — treated as no-op (task starts after flag)`);
  return { task: rest, warnings };
}
