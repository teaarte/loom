// Secrets are NEVER rendered raw. The server masks on every GET; the client
// mirror here lets the UI recognise a masked value (to mark a field "stored
// secret" and to round-trip it unchanged) without ever reconstructing the raw
// one. These tests pin the never-raw guarantee on the data the views consume.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isMaskedSecret, maskSecret } from "../src/lib/mask.js";

describe("maskSecret (mirror of the server helper)", () => {
  it("reveals at most the last 4 characters", () => {
    assert.equal(maskSecret("sk-ant-1234567890"), "*************7890");
    assert.equal(maskSecret("abcd"), "****");
    assert.equal(maskSecret("ab"), "**");
    assert.equal(maskSecret(""), "");
  });

  it("never echoes the leading body of the secret", () => {
    const raw = "super-secret-token-XYZ9";
    const masked = maskSecret(raw);
    assert.ok(!masked.includes("super"), "the body must not appear in the mask");
    assert.ok(masked.startsWith("*"));
    assert.equal(masked.slice(-4), "XYZ9");
  });
});

describe("isMaskedSecret", () => {
  it("recognises a server-masked value", () => {
    assert.equal(isMaskedSecret("****1234"), true);
    assert.equal(isMaskedSecret("****"), true);
    assert.equal(isMaskedSecret("*************7890"), true);
  });

  it("treats a secret:<name> reference as NOT masked (a pointer, shown verbatim)", () => {
    assert.equal(isMaskedSecret("secret:ANTHROPIC_API_KEY"), false);
  });

  it("treats a plain value as not masked", () => {
    assert.equal(isMaskedSecret("hello"), false);
    assert.equal(isMaskedSecret(""), false);
  });

  it("a masked value the UI received reads back as masked (so it is preserved, not re-sent raw)", () => {
    const masked = maskSecret("a-real-token-1234");
    assert.equal(isMaskedSecret(masked), true);
  });
});
