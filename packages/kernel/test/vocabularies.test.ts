import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertVocabKnown,
  kernelDefaultVocabularies,
} from "../src/vocabularies.js";
import { KernelError } from "../src/state.js";

describe("kernelDefaultVocabularies", () => {
  it("carries the kernel baselines and no bundle extensions", () => {
    const v = kernelDefaultVocabularies();
    assert.ok(v.output_kinds.has("nonreview"));
    assert.ok(v.output_kinds.has("reviewer"));
    assert.ok(v.audit_types.has("hook-failure"));
    assert.ok(v.error_classes.has("hook-failure"));
    assert.ok(v.decided_by.has("human"));
    assert.equal(v.output_kinds.bundle_extensions.size, 0);
    assert.equal(v.audit_types.bundle_extensions.size, 0);
  });
});

describe("assertVocabKnown", () => {
  const v = kernelDefaultVocabularies();

  it("passes silently for a declared value", () => {
    assert.doesNotThrow(() =>
      assertVocabKnown(v.output_kinds, "reviewer", "output_kind"),
    );
  });

  it("refuses an undeclared value with VOCAB_UNKNOWN + detail", () => {
    assert.throws(
      () => assertVocabKnown(v.output_kinds, "made-up", "output_kind"),
      (err: unknown) => {
        assert.ok(err instanceof KernelError);
        assert.equal((err as KernelError).code, "VOCAB_UNKNOWN");
        assert.equal((err as KernelError).detail?.["kind"], "output_kind");
        assert.equal((err as KernelError).detail?.["value"], "made-up");
        return true;
      },
    );
  });
});
