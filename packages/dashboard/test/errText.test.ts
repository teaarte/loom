// The single error-to-display helper that replaced the `instanceof ApiError ?
// … : …` shape every view repeated (the R3 de-dup). Pure, so it is unit-tested
// without a DOM.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiError, errText } from "../src/lib/api.js";

describe("errText", () => {
  it("renders an ApiError as the server's typed code: message envelope", () => {
    assert.equal(errText(new ApiError(400, "BAD_JSON", "request body must be valid JSON")), "BAD_JSON: request body must be valid JSON");
  });

  it("renders a plain Error as its message (no 'Error:' prefix)", () => {
    assert.equal(errText(new Error("network down")), "network down");
  });

  it("stringifies a non-Error throwable", () => {
    assert.equal(errText("nope"), "nope");
    assert.equal(errText(42), "42");
  });
});
