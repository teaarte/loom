import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  KERNEL_SENSITIVE_PATH_RULES,
  createPathRestrictedSandbox,
  fileReadTool,
  mergeSensitivePathRules,
} from "@loomfsm/kernel";
import type { SensitivePathRules, ToolContext } from "@loomfsm/kernel";

import { CODE_BUNDLE_SENSITIVE_PATH_RULES } from "../src/sandbox-rules.js";

// Build a tool context. When `rules` is omitted the tool falls back to the
// bare kernel floor — exactly the production fallback path.
function makeCtx(
  projectDir: string,
  rules?: SensitivePathRules,
): { ctx: ToolContext; audited: Record<string, unknown>[] } {
  const audited: Record<string, unknown>[] = [];
  const ctx: ToolContext = {
    project_dir: projectDir,
    sandbox: createPathRestrictedSandbox(projectDir),
    audit_emit: (p) => audited.push(p),
    ...(rules !== undefined ? { sensitive_path_rules: rules } : {}),
  };
  return { ctx, audited };
}

const MERGED = mergeSensitivePathRules(
  KERNEL_SENSITIVE_PATH_RULES,
  CODE_BUNDLE_SENSITIVE_PATH_RULES,
);

describe("@loomfsm/bundle-code — dev-ecosystem sandbox rules", () => {
  let project: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "loom-bundle-sandbox-"));
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it("refuses .npmrc once the bundle rules are merged, allows it under the bare kernel floor", async () => {
    writeFileSync(join(project, ".npmrc"), "//registry.example/:_authToken=secret", "utf8");

    // Bare floor (no bundle rules wired): .npmrc is NOT a kernel-floor
    // secret, so the read is allowed and returns content.
    {
      const { ctx } = makeCtx(project);
      const r = await fileReadTool.handler({ path: ".npmrc" }, ctx);
      assert.ok("content" in r, ".npmrc should be readable under the bare kernel floor");
    }

    // Merged rules (the production wiring): .npmrc is refused as a
    // sensitive file. This fails if the file tool ignores the carried
    // rules — i.e. if the bundle rules are not actually wired through.
    {
      const { ctx, audited } = makeCtx(project, MERGED);
      const r = await fileReadTool.handler({ path: ".npmrc" }, ctx);
      assert.ok("error" in r, ".npmrc must be refused once the bundle rules are merged");
      assert.equal(audited[0]?.error_class, "sandbox-violation");
      assert.match(String(audited[0]?.reason), /^sensitive-file:/);
    }
  });

  it("refuses .kube/config under the merged rules, allows it under the bare floor", async () => {
    mkdirSync(join(project, ".kube"), { recursive: true });
    writeFileSync(join(project, ".kube", "config"), "apiVersion: v1\nclusters: []", "utf8");

    {
      const { ctx } = makeCtx(project);
      const r = await fileReadTool.handler({ path: ".kube/config" }, ctx);
      assert.ok("content" in r, ".kube/config should be readable under the bare kernel floor");
    }
    {
      const { ctx, audited } = makeCtx(project, MERGED);
      const r = await fileReadTool.handler({ path: ".kube/config" }, ctx);
      assert.ok("error" in r, ".kube/config must be refused once the bundle rules are merged");
      assert.equal(audited[0]?.error_class, "sandbox-violation");
      assert.match(String(audited[0]?.reason), /^sensitive-dir:\/\.kube\//);
    }
  });

  it("keeps the kernel floor intact under the merge (.env still refused)", async () => {
    writeFileSync(join(project, ".env"), "SECRET=1", "utf8");
    const { ctx, audited } = makeCtx(project, MERGED);
    const r = await fileReadTool.handler({ path: ".env" }, ctx);
    assert.ok("error" in r, "the merge must preserve the kernel floor");
    assert.equal(audited[0]?.error_class, "sandbox-violation");
  });
});
