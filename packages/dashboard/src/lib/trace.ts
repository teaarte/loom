// Pure helpers for the agent-chain view — no DOM, no JSX, so they compile and
// unit-test under tsconfig.node.json. Domain-blind: they operate on the generic
// trace shape and name no bundle vocabulary.

import type { TraceAgent, TraceFinding, TraceVerdict } from "./types.js";

export interface TimedAgent extends TraceAgent {
  // Wall-clock from the previous run's persist time (or the task `started_at`
  // for the first) to this run's — a DERIVED approximation of how long the spawn
  // took, since exact per-spawn timing is not recorded. null when it can't be
  // computed (an unparseable stamp, or a negative delta from clock skew).
  duration_ms: number | null;
}

// Anchor each run's derived duration to the previous run's `recorded_at`, with
// the first anchored to the task's `started_at`. Input order is the chain order
// (the reader returns runs ascending by insert id).
export function deriveAgentDurations(agents: TraceAgent[], startedAt: string | null): TimedAgent[] {
  let prev = parseMs(startedAt);
  return agents.map((a) => {
    const at = parseMs(a.recorded_at);
    let duration: number | null = null;
    if (at !== null && prev !== null && at >= prev) duration = at - prev;
    if (at !== null) prev = at;
    return { ...a, duration_ms: duration };
  });
}

function parseMs(iso: string | null): number | null {
  if (iso === null || iso.length === 0) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

// The findings a given run produced — matched on the agent name + phase the run
// carries. Generic: it joins on the columns the store records, naming nothing.
export function findingsForAgent(
  findings: TraceFinding[],
  agent: string,
  phase: string,
): TraceFinding[] {
  return findings.filter((f) => f.agent === agent && f.phase === phase);
}

// The verdicts a given run produced — matched the same way.
export function verdictsForAgent(
  verdicts: TraceVerdict[],
  agent: string,
  phase: string,
): TraceVerdict[] {
  return verdicts.filter((v) => v.agent === agent && v.phase === phase);
}

// A compact token summary for one run: "12.3k in · 4.5k out · 1.2k cached".
// Empty when a run reports no usage (a provider with reports_usage=false).
export function tokenSummary(a: TraceAgent): string {
  const parts: string[] = [];
  if (a.tokens_in !== null && a.tokens_in > 0) parts.push(`${compact(a.tokens_in)} in`);
  if (a.tokens_out !== null && a.tokens_out > 0) parts.push(`${compact(a.tokens_out)} out`);
  if (a.tokens_cached !== null && a.tokens_cached > 0) parts.push(`${compact(a.tokens_cached)} cached`);
  return parts.join(" · ");
}

// Short human form for a count: 1234 → "1.2k", 2_500_000 → "2.5M".
export function compact(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
