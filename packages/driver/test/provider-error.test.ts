// Permanent provider-error classification + the executor surfacing it. The
// reported bug: changing the model mid-task → `400 … claude-sonnet-4-6 is not a
// valid model ID` retried 5× with backoff. The fix gives such failures their
// own non-retryable codes so the supervisor parks at once. No mocks — the
// classifier is pure and `parseClaudeResult` takes a stdout string directly.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { KernelError } from "@loomfsm/kernel";

import { parseClaudeResult } from "../src/claude-code-executor.js";
import {
  classifyPermanentProviderError,
  PERMANENT_PROVIDER_ERROR_CODES,
} from "../src/provider-error.js";

describe("classifyPermanentProviderError", () => {
  it("flags an invalid / unknown model id", () => {
    assert.equal(
      classifyPermanentProviderError("claude-sonnet-4-6 is not a valid model ID"),
      "invalid-model",
    );
    assert.equal(classifyPermanentProviderError("invalid model: foo"), "invalid-model");
    assert.equal(classifyPermanentProviderError("unknown model 'x'"), "invalid-model");
    assert.equal(
      classifyPermanentProviderError("model gpt-bogus does not exist"),
      "invalid-model",
    );
  });

  it("flags an auth / billing rejection", () => {
    assert.equal(classifyPermanentProviderError("invalid x-api-key"), "auth");
    assert.equal(classifyPermanentProviderError("authentication failed"), "auth");
    assert.equal(
      classifyPermanentProviderError("your credit balance is too low"),
      "auth",
    );
  });

  it("does NOT flag a generic / transient failure (stays retryable)", () => {
    assert.equal(classifyPermanentProviderError("connection reset by peer"), null);
    assert.equal(classifyPermanentProviderError("the model is overloaded, try again"), null);
    assert.equal(classifyPermanentProviderError(""), null);
  });
});

describe("parseClaudeResult — permanent error envelope", () => {
  it("surfaces an invalid-model error envelope as EXECUTOR_INVALID_MODEL", () => {
    const envelope = JSON.stringify({
      is_error: true,
      subtype: "error",
      result: "API Error 400: claude-sonnet-4-6 is not a valid model ID",
    });
    assert.throws(
      () => parseClaudeResult(envelope),
      (err: unknown) => err instanceof KernelError && err.code === "EXECUTOR_INVALID_MODEL",
    );
  });

  it("surfaces an auth error envelope as EXECUTOR_AUTH_FAILED", () => {
    const envelope = JSON.stringify({
      is_error: true,
      subtype: "error",
      result: "authentication failed: invalid x-api-key",
    });
    assert.throws(
      () => parseClaudeResult(envelope),
      (err: unknown) => err instanceof KernelError && err.code === "EXECUTOR_AUTH_FAILED",
    );
  });

  it("still surfaces a generic error envelope as the retryable EXECUTOR_FAILED", () => {
    const envelope = JSON.stringify({ is_error: true, subtype: "error", result: "boom" });
    assert.throws(
      () => parseClaudeResult(envelope),
      (err: unknown) => err instanceof KernelError && err.code === "EXECUTOR_FAILED",
    );
  });

  it("the permanent codes are both registered in the shared set", () => {
    assert.ok(PERMANENT_PROVIDER_ERROR_CODES.has("EXECUTOR_INVALID_MODEL"));
    assert.ok(PERMANENT_PROVIDER_ERROR_CODES.has("EXECUTOR_AUTH_FAILED"));
  });
});
