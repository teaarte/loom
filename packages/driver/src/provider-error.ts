// Classify a PERMANENT provider error from a backend's error text — one a
// retry cannot clear (an invalid / unknown model id, or an auth / credential /
// billing rejection), as distinct from a transient blip or a rate-limit.
//
// Why: a backend that 400s on a bad model id ("claude-sonnet-4-6 is not a valid
// model ID") returns the SAME failure on every attempt, so the supervisor's
// transient-retry loop spent its whole backoff budget re-running an identical,
// identically-failing spawn. These get their own error CODES so `drive()`
// surfaces them at once and the supervisor's classifier dispositions them
// TERMINAL — park with an actionable message instead of five pointless retries.
//
// Pattern-based over the backend's human-readable text: the `claude -p` JSON
// envelope carries no machine code that distinguishes these, so the only signal
// is the message. Kept CONSERVATIVE — only unambiguous phrasings match, so a
// genuine transient failure still falls through to the retryable EXECUTOR_FAILED
// rather than parking a task that a retry would have cleared.

export type PermanentProviderError = "invalid-model" | "auth";

// "…is not a valid model ID", "invalid model", "unknown model",
// "model 'x' does not exist", "no such model".
const INVALID_MODEL_RE =
  /(?:not a valid|invalid|unknown|unsupported) model|model[^.]{0,40}(?:not found|does not exist|is not valid)|no such model/i;

// Credential / billing rejections — also permanent until the operator fixes the
// key or balance, never cleared by retrying.
const AUTH_RE =
  /invalid (?:api[ _-]?key|x-api-key)|authentication (?:error|failed)|\bunauthorized\b|not authenticated|credit balance is too low|insufficient[_ ]?quota/i;

export function classifyPermanentProviderError(text: string): PermanentProviderError | null {
  if (text.length === 0) return null;
  if (INVALID_MODEL_RE.test(text)) return "invalid-model";
  if (AUTH_RE.test(text)) return "auth";
  return null;
}

// The KernelError code each permanent class surfaces as. Both are TERMINAL to
// the supervisor's classifier (neither is a transient nor a rate-limit code).
export const PERMANENT_PROVIDER_ERROR_CODE: Record<PermanentProviderError, string> = {
  "invalid-model": "EXECUTOR_INVALID_MODEL",
  auth: "EXECUTOR_AUTH_FAILED",
};

// The set of permanent provider error codes — shared by `drive()` (surface at
// once, no fast-retry) and the supervisor's classifier (disposition terminal).
export const PERMANENT_PROVIDER_ERROR_CODES: ReadonlySet<string> = new Set(
  Object.values(PERMANENT_PROVIDER_ERROR_CODE),
);
