// resolveBackend — the per-spawn backend picker. Pure: every case is a plain
// (mode, family, ccAvailable) → result mapping, no I/O.
//
// Covers: auto CC-first + the loud anthropic→anthropic-sdk fallback; raw-family
// routing; bare-family (no signal) CC-only default; an unserviceable family;
// explicit-pin validation (compatible passes, incompatible rejected, pinned CC
// without the CLI rejected); and that validatePair still reads the shared core
// after the refactor.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveBackend, validateBackendFamily, validatePair } from "../src/index.js";

describe("resolveBackend — auto (CC-first)", () => {
  it("routes an anthropic model to claude-code when the CLI is present (no notice)", () => {
    const r = resolveBackend({ configBackend: "auto", family: "anthropic", ccAvailable: true });
    assert.deepEqual(r, { ok: true, backend: "claude-code" });
  });

  it("falls back to anthropic-sdk with a LOUD notice when Claude Code is absent", () => {
    const r = resolveBackend({ configBackend: "auto", family: "anthropic", ccAvailable: false });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.backend, "anthropic-sdk");
    assert.match(r.notice ?? "", /falling back to 'anthropic-sdk'/);
    assert.match(r.notice ?? "", /API credential/);
  });

  it("routes openrouter / ollama families to their raw backend (cc irrelevant)", () => {
    assert.deepEqual(resolveBackend({ configBackend: "auto", family: "openrouter", ccAvailable: false }), {
      ok: true,
      backend: "openrouter",
    });
    assert.deepEqual(resolveBackend({ configBackend: "auto", family: "ollama", ccAvailable: true }), {
      ok: true,
      backend: "ollama",
    });
  });

  it("defaults a bare-family model to claude-code, and errors when CC is absent", () => {
    assert.deepEqual(resolveBackend({ configBackend: "auto", family: undefined, ccAvailable: true }), {
      ok: true,
      backend: "claude-code",
    });
    const r = resolveBackend({ configBackend: "auto", family: undefined, ccAvailable: false });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /no usable backend/);
    assert.match(r.error, /Claude Code CLI/);
  });

  it("returns a clean error for a family with no wired backend yet (e.g. google)", () => {
    const r = resolveBackend({ configBackend: "auto", family: "google", ccAvailable: true });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /no backend is available for provider family 'google'/);
    assert.match(r.error, /later step/);
  });
});

describe("resolveBackend — explicit pin (validate, never override)", () => {
  it("accepts a compatible pin", () => {
    assert.deepEqual(resolveBackend({ configBackend: "anthropic-sdk", family: "anthropic", ccAvailable: false }), {
      ok: true,
      backend: "anthropic-sdk",
    });
    assert.deepEqual(resolveBackend({ configBackend: "openrouter", family: "openrouter", ccAvailable: false }), {
      ok: true,
      backend: "openrouter",
    });
  });

  it("accepts a pin with a bare-family model (resolves within the backend)", () => {
    assert.deepEqual(resolveBackend({ configBackend: "openrouter", family: undefined, ccAvailable: false }), {
      ok: true,
      backend: "openrouter",
    });
  });

  it("rejects an incompatible pin with a helpful suggestion", () => {
    const r = resolveBackend({ configBackend: "openrouter", family: "anthropic", ccAvailable: true });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /can't run a anthropic model/);
  });

  it("rejects an unknown backend pin (typo guard)", () => {
    const r = resolveBackend({ configBackend: "claud", family: "anthropic", ccAvailable: true });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /unknown backend 'claud'/);
  });

  it("rejects a pinned claude-code when the CLI is not available", () => {
    const r = resolveBackend({ configBackend: "claude-code", family: "anthropic", ccAvailable: false });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /pinned but the Claude Code CLI was not found/);
  });
});

describe("validatePair / validateBackendFamily parity after refactor", () => {
  it("validatePair defers to the shared family core", () => {
    assert.deepEqual(validatePair("codex", "google:gemini-2.x"), validateBackendFamily("codex", "google"));
    assert.equal(validatePair("auto", "anything:x").ok, true);
    assert.equal(validatePair("openrouter", "openrouter/anything").ok, true); // bare (no `:` family) → ok
    assert.equal(validatePair("anthropic-sdk", "anthropic:claude-sonnet").ok, true);
  });
});
