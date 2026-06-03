// Rate-limit detection at the executor/capture seam — backend-shaped, pure,
// and INJECTABLE.
//
// A long unattended run must survive a sustained rate-limit / quota window by
// WAITING, not by escalating. To do that the supervisor needs a distinguishable
// signal, and the only place the signal exists is the backend's own error shape
// — so detection lives HERE (the `claude -p` capture seam), never in the
// generic supervisor, and is injectable so a different backend can supply its
// own matcher without the daemon learning a vendor assumption.
//
// The signal is whatever the capture seam has on hand: a pre-parsed JSON
// envelope (when the output parsed), the raw stdout (which still carries the
// envelope even on a non-zero exit), stderr, and the exit code. The default
// matcher reads the empirically-confirmed top-level HTTP-status field first and
// falls back to a text pattern; a deployment can replace it wholesale.

// What the capture seam can observe about one finished spawn. All optional —
// the seam fills in whichever it has (the parser path has `envelope`; the
// non-zero-exit path has `stdout`/`stderr`/`exitCode`).
export interface RateLimitSignal {
  // The parsed JSON envelope, when the output parsed cleanly.
  envelope?: Record<string, unknown>;
  // The raw captured stdout. The backend writes its JSON envelope here even on
  // a non-zero exit, so this carries the structured status when `envelope` is
  // not separately parsed.
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
}

// Returns true when the signal is a rate-limit / quota condition that will only
// clear with TIME (so the caller should wait, not retry-and-escalate).
export type RateLimitDetector = (signal: RateLimitSignal) => boolean;

// HTTP statuses that mean "you are over a usage/rate limit — wait". 429 is the
// canonical rate_limit_error (provider rate limit OR subscription plan quota).
// Deliberately EXCLUDES 5xx / overloaded (503/529): those are short-transient
// and the backend already retried them internally — a surfaced one earns an
// ordinary fast backoff, not a multi-hour wait.
const RATE_LIMIT_STATUSES = new Set<number>([429]);

// Text fallback for when the structured status is absent but the message names
// a limit — including the subscription "you've hit your <window> limit" wording.
const RATE_LIMIT_TEXT =
  /rate.?limit|usage limit|too many requests|\b429\b|hit your (?:session|weekly|opus|usage) limit|quota/i;

function statusOf(envelope: Record<string, unknown> | undefined): number | undefined {
  if (envelope === undefined) return undefined;
  const s = envelope["api_error_status"];
  return typeof s === "number" && Number.isFinite(s) ? s : undefined;
}

function envelopeText(envelope: Record<string, unknown> | undefined): string {
  if (envelope === undefined) return "";
  const r = envelope["result"];
  return typeof r === "string" ? r : "";
}

// Best-effort parse of captured stdout into the JSON envelope. Returns
// undefined on anything that is not a JSON object (never throws — detection is
// a classification, never a failure path).
function parseEnvelope(stdout: string | undefined): Record<string, unknown> | undefined {
  if (stdout === undefined) return undefined;
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
}

// The documented default: read the top-level `api_error_status` (from the
// supplied envelope, or parsed from raw stdout), treat 429 as rate-limited,
// then fall back to a text match over the envelope's `result` message and
// stderr. See the rate-limit-signal ADR for the empirical grounding.
export const defaultRateLimitDetector: RateLimitDetector = (signal: RateLimitSignal): boolean => {
  const envelope = signal.envelope ?? parseEnvelope(signal.stdout);
  const status = statusOf(envelope);
  if (status !== undefined && RATE_LIMIT_STATUSES.has(status)) return true;
  const text = `${envelopeText(envelope)}\n${signal.stderr ?? ""}`;
  return RATE_LIMIT_TEXT.test(text);
};
