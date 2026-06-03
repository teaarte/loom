// The default rate-limit detector — grounded in the REAL `claude -p` envelope
// shapes captured in the P0 spike (a success envelope, a 404 error envelope)
// plus a synthesised 429 and the subscription usage-limit wording. The detector
// is a pure classification; these assert it fires on a genuine rate-limit and
// never on a healthy or merely-failed run.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { defaultRateLimitDetector } from "../src/index.js";

// A trimmed copy of the real success envelope captured from claude 2.1.154.
const SUCCESS_ENVELOPE = {
  type: "result",
  subtype: "success",
  is_error: false,
  api_error_status: null,
  result: "OK",
  total_cost_usd: 0.13,
};

// A trimmed copy of the real induced-error envelope (bogus --model → 404).
const NOT_RATE_LIMITED_ERROR = {
  type: "result",
  subtype: "success",
  is_error: true,
  api_error_status: 404,
  result: "There's an issue with the selected model (claude-nonexistent). It may not exist.",
};

describe("defaultRateLimitDetector — over a parsed envelope", () => {
  it("does not fire on a healthy success envelope", () => {
    assert.equal(defaultRateLimitDetector({ envelope: SUCCESS_ENVELOPE }), false);
  });

  it("does not fire on a non-rate-limit API error (404)", () => {
    assert.equal(defaultRateLimitDetector({ envelope: NOT_RATE_LIMITED_ERROR }), false);
  });

  it("fires on api_error_status 429 (the canonical rate_limit_error)", () => {
    assert.equal(
      defaultRateLimitDetector({
        envelope: { ...NOT_RATE_LIMITED_ERROR, api_error_status: 429 },
      }),
      true,
    );
  });

  it("does NOT fire on a 5xx / overloaded status (short-transient, not a wait)", () => {
    assert.equal(
      defaultRateLimitDetector({ envelope: { ...NOT_RATE_LIMITED_ERROR, api_error_status: 529 } }),
      false,
    );
    assert.equal(
      defaultRateLimitDetector({ envelope: { ...NOT_RATE_LIMITED_ERROR, api_error_status: 503 } }),
      false,
    );
  });

  it("fires on the subscription usage-limit wording when status is absent", () => {
    assert.equal(
      defaultRateLimitDetector({
        envelope: { is_error: true, result: "You've hit your weekly limit · resets Mon 12:00am" },
      }),
      true,
    );
  });
});

describe("defaultRateLimitDetector — over raw stdout / stderr (the non-zero-exit seam)", () => {
  it("parses the envelope out of raw stdout and reads api_error_status", () => {
    const stdout = JSON.stringify({ is_error: true, api_error_status: 429, result: "rate_limit_error" });
    assert.equal(defaultRateLimitDetector({ stdout, exitCode: 1 }), true);
  });

  it("falls back to a text match on stderr", () => {
    assert.equal(
      defaultRateLimitDetector({ stderr: "Error: 429 Too Many Requests", exitCode: 1 }),
      true,
    );
  });

  it("does not fire on a generic non-rate-limit failure", () => {
    assert.equal(
      defaultRateLimitDetector({ stdout: "boom", stderr: "segfault", exitCode: 1 }),
      false,
    );
  });

  it("is null-safe on an empty / absent signal", () => {
    assert.equal(defaultRateLimitDetector({}), false);
    assert.equal(defaultRateLimitDetector({ stdout: "", stderr: "" }), false);
  });
});
