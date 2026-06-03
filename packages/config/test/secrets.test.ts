// Secret resolution + masking. secrets.json wins over env; an absent secret
// resolves to undefined; refs are recognized; masking never reveals more than
// the last 4 characters.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isSecretRef,
  maskSecret,
  resolveMaybeRef,
  resolveSecret,
  secretRefName,
  writeSecrets,
} from "../src/index.js";

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "loom-config-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("resolveSecret", () => {
  it("prefers secrets.json, falls back to env, then undefined", () => {
    const home = tmp();
    writeSecrets(home, { KEY: "from-file" });
    assert.equal(resolveSecret("KEY", home, { KEY: "from-env" }), "from-file");
    assert.equal(resolveSecret("OTHER", home, { OTHER: "from-env" }), "from-env");
    assert.equal(resolveSecret("MISSING", home, {}), undefined);
  });
});

describe("secret references", () => {
  it("recognizes and resolves a secret:<name> ref", () => {
    const home = tmp();
    writeSecrets(home, { TG: "tok" });
    assert.equal(isSecretRef("secret:TG"), true);
    assert.equal(isSecretRef("literal"), false);
    assert.equal(secretRefName("secret:TG"), "TG");
    assert.equal(resolveMaybeRef("secret:TG", home, {}), "tok");
    assert.equal(resolveMaybeRef("literal-value", home, {}), "literal-value");
    assert.equal(resolveMaybeRef("secret:MISSING", home, {}), undefined);
  });
});

describe("maskSecret", () => {
  it("never reveals more than the last 4 chars", () => {
    assert.equal(maskSecret("abcdefghij"), "******ghij");
    assert.equal(maskSecret("ab"), "**");
    assert.ok(!maskSecret("supersecretvalue").includes("supersecret"));
  });
});
