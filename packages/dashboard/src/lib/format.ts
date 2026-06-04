// Pure formatting helpers for the log + status views — no DOM, no JSX, so they
// compile and unit-test under tsconfig.node.json. Domain-blind: they format the
// generic FSM log/status shape and name no bundle vocabulary.

import type { LogLine } from "./types.js";

// HH:MM:SS from an ISO timestamp (local time — a localhost console). The raw
// value is returned verbatim when it does not parse; "" for an absent stamp.
export function formatClock(ts: string | undefined): string {
  if (ts === undefined || ts.length === 0) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// One detail value rendered compactly. Known numerics get a friendlier form
// (cost_usd → $x.xx); a nested object is shallow-stringified; everything else
// is its plain string. Generic — `cost_usd` is a transport accounting field,
// not a bundle concept.
export function formatDetailValue(key: string, value: unknown): string {
  if (key === "cost_usd" && typeof value === "number") return `$${value.toFixed(2)}`;
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return String(value);
  return JSON.stringify(value);
}

// A log line's detail object → compact `key value` pairs (two-space separated),
// instead of a raw `JSON.stringify`. Empty string when there is no detail.
export function formatDetail(detail: Record<string, unknown> | undefined): string {
  if (detail === undefined) return "";
  return Object.entries(detail)
    .map(([k, v]) => `${k} ${formatDetailValue(k, v)}`)
    .join("  ");
}

// The pieces a renderer needs to lay out one log line: a clock, a level (for
// the colour chip), the event, and the formatted detail. Pure so the layout is
// node-testable without a DOM.
export interface LogParts {
  clock: string;
  level: string;
  event: string;
  detail: string;
}

export function logParts(line: LogLine): LogParts {
  return {
    clock: formatClock(line.ts),
    level: line.level ?? "info",
    event: line.event ?? "",
    detail: formatDetail(line.detail),
  };
}

// Human elapsed for a duration in ms: "1h 02m 03s" / "2m 03s" / "12s".
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

// Total elapsed for a task: from `started_at` to `ended_at` (final, once
// terminal) or to `nowMs` (live, while running). Empty string when no usable
// start is known.
export function elapsedFor(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
  nowMs: number,
): string {
  if (startedAt === undefined || startedAt === null || startedAt.length === 0) return "";
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return "";
  const ended = endedAt !== undefined && endedAt !== null && endedAt.length > 0 ? Date.parse(endedAt) : NaN;
  const end = Number.isNaN(ended) ? nowMs : ended;
  return formatDuration(end - start);
}
