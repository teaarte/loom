import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { validateImportScope } from "../src/bundle-loader/validators/import-scope.js";
import { KernelError } from "../src/state.js";

// Write a single bundle source file into a fresh temp dir, run the
// import-scope sweep against it, and clean up.
function withBundleSource(file: string, body: string, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "loom-import-scope-"));
  try {
    writeFileSync(join(dir, file), body);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertRefused(file: string, body: string): void {
  withBundleSource(file, body, (dir) => {
    assert.throws(
      () => validateImportScope(dir),
      (err: unknown) =>
        err instanceof KernelError && err.code === "BUNDLE_IMPORT_SCOPE_VIOLATION",
    );
  });
}

function assertAccepted(file: string, body: string): void {
  withBundleSource(file, body, (dir) => {
    assert.doesNotThrow(() => validateImportScope(dir));
  });
}

describe("validateImportScope — raw Transaction reach", () => {
  // Baseline coverage: the named-import form was caught before this
  // pass too. Kept so the broadened regex demonstrably still refuses it.
  it("refuses a named import of Transaction", () => {
    assertRefused(
      "named.ts",
      `import type { Transaction } from "@loom/kernel";\nexport const x = 1;\n`,
    );
  });

  // Regression: the binding regex now accepts `export` in place of
  // `import`, so a bundle handing the raw handle out its OWN barrel is
  // refused. Reverting the verb to import-only lets this through.
  it("refuses a re-export of Transaction from @loom/kernel", () => {
    assertRefused("reexport.ts", `export { Transaction } from "@loom/kernel";\n`);
  });

  it("refuses a re-export through the deep transaction path", () => {
    assertRefused(
      "reexport-path.ts",
      `export { Transaction } from "@loom/kernel/state/transaction.js";\n`,
    );
  });

  // Regression: a namespace import binds the kernel surface to a local
  // name, and `K.Transaction` reaches the raw handle indirectly. The new
  // namespace-aware check flags the member-access line.
  it("refuses a namespace import whose member access reaches Transaction", () => {
    assertRefused(
      "namespace.ts",
      `import * as K from "@loom/kernel";\nexport function f(tx: K.Transaction) {\n  return tx;\n}\n`,
    );
  });

  // False-positive guard: a namespace import of some OTHER symbol must
  // pass — the namespace binding alone is not a violation.
  it("accepts a namespace import of a non-Transaction symbol", () => {
    assertAccepted(
      "namespace-ok.ts",
      `import * as K from "@loom/kernel";\nexport const r = {} as K.Registry;\n`,
    );
  });

  it("accepts a named import of a non-Transaction symbol", () => {
    assertAccepted(
      "named-ok.ts",
      `import type { Registry } from "@loom/kernel";\nexport const x = 1;\n`,
    );
  });
});
