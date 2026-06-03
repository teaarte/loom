// Backend credential resolution — the documented convention (a backend reads
// its key from a conventionally-named secret) with an optional override, over a
// REAL secrets store (a temp dir, chmod-600 file written by the store), never a
// mocked one. Plus the masking guarantee that no display path leaks a full key.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  BACKEND_CREDENTIAL,
  maskSecret,
  resolveBackendCredential,
  writeSecrets,
} from "../src/index.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "loom-creds-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("resolveBackendCredential — convention + override", () => {
  it("resolves a backend's key from its conventionally-named secret in the store", () => {
    writeSecrets(home, { OPENROUTER_API_KEY: "sk-or-123456" });
    const creds = resolveBackendCredential("openrouter", { loomHome: home, env: {} });
    assert.equal(creds.apiKey, "sk-or-123456");
    assert.equal(creds.baseUrl, undefined);
  });

  it("falls back to the environment for the conventional key (env beats absent file)", () => {
    const creds = resolveBackendCredential("anthropic-sdk", {
      loomHome: home,
      env: { ANTHROPIC_API_KEY: "sk-ant-env" },
    });
    assert.equal(creds.apiKey, "sk-ant-env");
  });

  it("resolves a base URL (no key) for the local backend from its env", () => {
    const creds = resolveBackendCredential("ollama", {
      loomHome: home,
      env: { OLLAMA_HOST: "http://gpu-box:11434" },
    });
    assert.equal(creds.apiKey, undefined);
    assert.equal(creds.baseUrl, "http://gpu-box:11434");
  });

  it("an override key_ref (secret:<name>) wins over the convention", () => {
    writeSecrets(home, { OPENROUTER_API_KEY: "conventional", TEAM_KEY: "sk-override" });
    const creds = resolveBackendCredential("openrouter", {
      loomHome: home,
      env: {},
      override: { key_ref: "secret:TEAM_KEY" },
    });
    assert.equal(creds.apiKey, "sk-override");
  });

  it("yields no key for claude-code (its login is OAuth, resolved by the executor)", () => {
    assert.equal(BACKEND_CREDENTIAL["claude-code"], undefined);
    const creds = resolveBackendCredential("claude-code", { loomHome: home, env: {} });
    assert.equal(creds.apiKey, undefined);
  });

  it("returns an empty credential when neither store nor env has the key", () => {
    const creds = resolveBackendCredential("openrouter", { loomHome: home, env: {} });
    assert.deepEqual(creds, {});
  });
});

describe("maskSecret — never leaks more than the last 4 chars", () => {
  it("masks all but the last four chars", () => {
    assert.equal(maskSecret("sk-1234567890"), "*********7890");
    assert.match(maskSecret("sk-real-secret-value"), /alue$/); // last 4 of "...value"
    assert.equal(maskSecret("sk-real-secret-value").includes("secret"), false);
  });
});
