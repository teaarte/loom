import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { KernelError } from "../src/state.js";
import { buildVocabularies } from "../src/vocabularies.js";
import type { Bundle } from "../src/types/bundle.js";
import {
  applyOutputCompression,
  createPassthroughSandbox,
  createPathRestrictedSandbox,
  KERNEL_SENSITIVE_PATH_RULES,
  mergeSensitivePathRules,
  resolveSafePath,
  resolveSandbox,
} from "../src/sandbox/index.js";

// ============================================================================
// resolveSafePath — path discipline
// ============================================================================

describe("resolveSafePath", () => {
  let project: string;
  let outside: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "loom-sandbox-proj-"));
    outside = mkdtempSync(join(tmpdir(), "loom-sandbox-out-"));
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("accepts a legitimate in-project file", async () => {
    writeFileSync(join(project, "src.ts"), "x", "utf8");
    const r = await resolveSafePath("src.ts", project);
    assert.ok(r.ok);
    if (r.ok) assert.ok(r.path.endsWith("src.ts"));
  });

  it("accepts a not-yet-existing in-project target (file_write case)", async () => {
    const r = await resolveSafePath("new/dir/file.txt", project);
    // The leaf has no realpath; the guard canonicalizes the longest
    // existing ancestor (the project root) and re-appends the remainder.
    assert.ok(r.ok);
    if (r.ok) {
      // Resolve the root the same way the guard does so the comparison
      // holds even when the temp root is itself a symlink (macOS /var).
      const root = await realpath(project);
      assert.ok(
        r.path === root || r.path.startsWith(root + sep),
        `${r.path} must be under ${root}`,
      );
      assert.ok(
        r.path.endsWith(join("new", "dir", "file.txt")),
        `${r.path} must end with the requested remainder`,
      );
    }
  });

  it("refuses a not-yet-existing target that escapes the project (no symlink)", async () => {
    // The leaf does not exist, so there is no realpath to follow. The old
    // lexical fallback trusted the `..` and let the write land outside;
    // canonicalizing the existing ancestor catches it.
    const r = await resolveSafePath("../escape/new.txt", project);
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.reason, "path-escapes-project");
  });

  it("refuses a new leaf under an in-project dir symlink that points outside", async () => {
    // A directory symlink inside the project whose target is outside it.
    // Writing a BRAND-NEW file *through* it must resolve to the real
    // (outside) parent and be refused — otherwise the sole write guard is
    // bypassed on the file_write path.
    symlinkSync(outside, join(project, "escape-dir"));
    const r = await resolveSafePath("escape-dir/pwned.txt", project);
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.reason, "path-escapes-project");
  });

  it("refuses a symlink that escapes the project after realpath", async () => {
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "top secret", "utf8");
    symlinkSync(secret, join(project, "link-out"));
    const r = await resolveSafePath("link-out", project);
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.reason, "path-escapes-project");
  });

  it("refuses an OS credential folder outside the project via the escape check", async () => {
    // The primary guard for operating-system secret folders: anything that
    // resolves outside the project (~/.ssh, /etc, ~/.aws) is refused before
    // the blocklist is even consulted. Simulate ~/.ssh/id_rsa as an absolute
    // path under a sibling root.
    const homeSsh = join(outside, ".ssh");
    mkdirSync(homeSsh, { recursive: true });
    writeFileSync(join(homeSsh, "id_rsa"), "KEY", "utf8");
    const r = await resolveSafePath(join(homeSsh, "id_rsa"), project);
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.reason, "path-escapes-project");
  });

  it("refuses an absolute system path via the escape check", async () => {
    const r = await resolveSafePath("/etc/passwd", project);
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.reason, "path-escapes-project");
  });

  // The neutral floor's credential dirs are dot-prefixed so they never
  // collide with ordinary project folders. Each must trip with its token;
  // removing one from KERNEL_SENSITIVE_DIRS lets its case through → fail.
  it("refuses each in-project credential directory", async () => {
    const cases: { rel: string; token: string }[] = [
      { rel: ".ssh/config", token: "/.ssh/" },
      { rel: ".aws/credentials_dir_marker", token: "/.aws/" },
      { rel: ".gnupg/pubring.kbx", token: "/.gnupg/" },
      { rel: ".gcp/key", token: "/.gcp/" },
      { rel: ".azure/token", token: "/.azure/" },
      { rel: ".config/gcloud/creds.db", token: "/.config/gcloud/" },
      { rel: ".config/git/credentials_marker", token: "/.config/git/" },
    ];
    for (const { rel, token } of cases) {
      mkdirSync(join(project, rel, ".."), { recursive: true });
      writeFileSync(join(project, rel), "x", "utf8");
      const r = await resolveSafePath(rel, project);
      assert.ok(!r.ok, `${rel} should be refused`);
      if (!r.ok) assert.equal(r.reason, `sensitive-dir:${token}`);
    }
  });

  // One filename per neutral pattern, chosen so each depends on exactly that
  // pattern: dropping any pattern lets its filename through → fail.
  it("refuses every neutral sensitive-file pattern", async () => {
    const cases = [
      ".env", // bare
      ".env.production", // dotted suffix
      ".envrc",
      ".netrc",
      ".pgpass",
      "credentials", // no extension
      "credentials.json",
      "secret", // singular, no extension
      "secrets", // plural
      "secrets.json",
      "secrets.yaml",
      "id_rsa",
      "id_dsa",
      "id_ecdsa",
      "id_ed25519",
      "service-account-key.json",
      "service_account_key", // no extension
    ];
    for (const name of cases) {
      writeFileSync(join(project, name), "x", "utf8");
      const r = await resolveSafePath(name, project);
      assert.ok(!r.ok, `${name} should be refused`);
      if (!r.ok) {
        assert.ok(
          r.reason.startsWith("sensitive-file:"),
          `${name} → ${r.reason}`,
        );
      }
    }
  });

  it("does NOT block generic folder names that live in real projects", async () => {
    // The floor must never refuse ordinary directories. Bare system tokens
    // (dev/, var/, etc/) are intentionally absent — they would false-positive
    // here; OS system paths are the escape check's job.
    const dirs = ["dev", "var", "etc", "config", "src", "lib", "proc"];
    for (const d of dirs) {
      mkdirSync(join(project, d), { recursive: true });
      writeFileSync(join(project, d, "file.ts"), "x", "utf8");
      const r = await resolveSafePath(`${d}/file.ts`, project);
      assert.ok(r.ok, `${d}/ should be allowed`);
    }
  });

  it("does not refuse innocuous files that merely resemble secret names", async () => {
    const innocuous = [
      "environment-notes.md", // contains 'env' but not '.env'
      "my-secrets-guide.txt", // 'secrets' mid-name, not a tail match
      "credentials-howto.md", // 'credentials' mid-name
      "id_rsa_rotation.md", // 'id_rsa' followed by '_', not '$' or '.'
      ".npmrc", // ecosystem-specific: NOT in the neutral floor (bundle adds it)
    ];
    for (const name of innocuous) {
      writeFileSync(join(project, name), "x", "utf8");
      const r = await resolveSafePath(name, project);
      assert.ok(r.ok, `${name} should be allowed by the neutral floor`);
    }
  });

  // The extension seam: a bundle/provider contributes domain rules on top of
  // the neutral floor. The same path is allowed by the default floor and
  // refused once the domain rule is merged in — proving (a) extensibility and
  // (b) that ecosystem patterns genuinely left the kernel default.
  it("applies bundle-contributed rules merged on top of the floor", async () => {
    writeFileSync(join(project, ".npmrc"), "//registry/:_authToken=x", "utf8");
    mkdirSync(join(project, ".kube"), { recursive: true });
    writeFileSync(join(project, ".kube", "config"), "x", "utf8");

    // Default floor: both allowed (they are not kernel-neutral secrets).
    assert.ok((await resolveSafePath(".npmrc", project)).ok);
    assert.ok((await resolveSafePath(".kube/config", project)).ok);

    const domainRules = {
      dirs: ["/.kube/"],
      filePatterns: [/(^|\/)\.npmrc$/],
    };
    const merged = mergeSensitivePathRules(
      KERNEL_SENSITIVE_PATH_RULES,
      domainRules,
    );

    const npmrc = await resolveSafePath(".npmrc", project, merged);
    assert.ok(!npmrc.ok);
    if (!npmrc.ok) assert.match(npmrc.reason, /^sensitive-file:/);

    const kube = await resolveSafePath(".kube/config", project, merged);
    assert.ok(!kube.ok);
    if (!kube.ok) assert.equal(kube.reason, "sensitive-dir:/.kube/");

    // The neutral floor still fires through the merged set.
    writeFileSync(join(project, ".env"), "S=1", "utf8");
    const env = await resolveSafePath(".env", project, merged);
    assert.ok(!env.ok);
  });
});

// ============================================================================
// path-restricted sandbox plugin
// ============================================================================

describe("path-restricted sandbox", () => {
  let project: string;
  let outside: string;
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "loom-pr-proj-"));
    outside = mkdtempSync(join(tmpdir(), "loom-pr-out-"));
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("advertises filesystem isolation only", () => {
    const sb = createPathRestrictedSandbox(project);
    assert.equal(sb.name, "path-restricted");
    assert.deepEqual(sb.capabilities, {
      filesystem_isolation: true,
      network_isolation: false,
      process_isolation: false,
      resource_limits: false,
    });
  });

  it("refuses exec without spawning a process", async () => {
    const sb = createPathRestrictedSandbox(project);
    const r = await sb.exec("echo hi", {});
    assert.equal(r.exit_code, 126);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /native OS sandbox/);
    assert.equal(r.duration_ms, 0);
    assert.equal(r.timed_out, false);
  });

  it("reads and writes in-project files through path discipline", async () => {
    const sb = createPathRestrictedSandbox(project);
    await sb.write_file("note.txt", "hello");
    assert.equal(await sb.read_file("note.txt"), "hello");
  });

  it("throws SANDBOX_VIOLATION on a read that escapes the project", async () => {
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "nope", "utf8");
    symlinkSync(secret, join(project, "link-out"));
    const sb = createPathRestrictedSandbox(project);
    await assert.rejects(
      sb.read_file("link-out"),
      (err: unknown) =>
        err instanceof KernelError &&
        err.code === "SANDBOX_VIOLATION" &&
        err.detail?.reason === "path-escapes-project",
    );
  });

  it("throws SANDBOX_VIOLATION on a write that escapes the project", async () => {
    const target = join(outside, "victim.txt");
    writeFileSync(target, "original", "utf8");
    symlinkSync(target, join(project, "link-out"));
    const sb = createPathRestrictedSandbox(project);
    await assert.rejects(
      sb.write_file("link-out", "overwritten"),
      (err: unknown) =>
        err instanceof KernelError &&
        err.code === "SANDBOX_VIOLATION" &&
        err.detail?.reason === "path-escapes-project",
    );
    // The out-of-project target was not touched.
    assert.equal(readFileSync(target, "utf8"), "original");
  });
});

// ============================================================================
// passthrough sandbox plugin
// ============================================================================

describe("passthrough sandbox", () => {
  it("advertises no isolation and audits a startup warning", () => {
    const audited: Record<string, unknown>[] = [];
    const sb = createPassthroughSandbox({
      audit_emit: (p) => audited.push(p),
    });
    assert.equal(sb.name, "passthrough");
    assert.deepEqual(sb.capabilities, {
      filesystem_isolation: false,
      network_isolation: false,
      process_isolation: false,
      resource_limits: false,
    });
    assert.equal(audited.length, 1);
    const warning = audited[0];
    assert.equal(warning?.type, "tool-call");
    assert.equal(warning?.sandbox, "passthrough");
    assert.match(String(warning?.warning), /no isolation/);
    // No self-minted timestamp — the substrate never reads a clock.
    assert.equal("ts" in (warning ?? {}), false);
  });

  it("does not throw when no audit sink is provided", () => {
    const sb = createPassthroughSandbox();
    assert.equal(sb.name, "passthrough");
  });

  it("exec actually runs the command (no isolation)", async () => {
    const sb = createPassthroughSandbox();
    const r = await sb.exec("printf hi", {});
    assert.equal(r.exit_code, 0);
    assert.equal(r.stdout, "hi");
    assert.equal(r.timed_out, false);
    // No self-minted duration — the caller stamps wall-clock time.
    assert.equal(r.duration_ms, 0);
  });

  it("exec surfaces a non-zero exit code", async () => {
    const sb = createPassthroughSandbox();
    const r = await sb.exec("exit 3", {});
    assert.equal(r.exit_code, 3);
  });

  it("exec reports timed_out when the timeout fires", async () => {
    const sb = createPassthroughSandbox();
    const r = await sb.exec("sleep 5", { timeout_ms: 50 });
    assert.equal(r.timed_out, true);
    assert.notEqual(r.exit_code, 0);
  });

  it("read_file / write_file pass straight through with no path discipline", async () => {
    // passthrough binds to no project — it can touch a path the
    // path-restricted boundary would refuse. That is the whole (dev-only)
    // point, and the contrast is worth pinning.
    const out = mkdtempSync(join(tmpdir(), "loom-passthru-"));
    try {
      const target = join(out, "anywhere.txt");
      const sb = createPassthroughSandbox();
      await sb.write_file(target, "free reign");
      assert.equal(await sb.read_file(target), "free reign");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// resolveSandbox — default selection
// ============================================================================

describe("resolveSandbox", () => {
  it("defaults to path-restricted when no kind is given", () => {
    const sb = resolveSandbox(undefined, { projectDir: tmpdir() });
    assert.equal(sb.name, "path-restricted");
  });

  it("selects passthrough only when explicitly asked", () => {
    const audited: Record<string, unknown>[] = [];
    const sb = resolveSandbox("passthrough", {
      projectDir: tmpdir(),
      audit_emit: (p) => audited.push(p),
    });
    assert.equal(sb.name, "passthrough");
    assert.equal(audited.length, 1);
  });

  it("treats an explicit path-restricted kind as path-restricted", () => {
    const sb = resolveSandbox("path-restricted", { projectDir: tmpdir() });
    assert.equal(sb.name, "path-restricted");
  });
});

// ============================================================================
// output compression — deterministic strategies
// ============================================================================

describe("applyOutputCompression", () => {
  // Distinguishable head and tail so a head/tail mix-up is caught: the
  // markers alone (prefix vs suffix) would NOT reveal a content swap.
  const HEAD = "HEADHEADHEAD";
  const TAIL = "TAILTAILTAIL";
  const big = HEAD + "x".repeat(5000) + TAIL;

  it("passes through below the threshold", () => {
    const r = applyOutputCompression("short", { strategy: "truncate-head" });
    assert.equal(r.compressed, false);
    assert.equal(r.content, "short");
  });

  it("passes through when size equals the threshold (boundary)", () => {
    const exact = "y".repeat(100);
    const r = applyOutputCompression(exact, {
      strategy: "truncate-head",
      threshold_bytes: 100,
    });
    assert.equal(r.compressed, false);
    assert.equal(r.content, exact);
  });

  it("never compresses strategy none", () => {
    const r = applyOutputCompression(big, { strategy: "none" });
    assert.equal(r.compressed, false);
    assert.equal(r.content, big);
  });

  it("summarize is a documented no-op", () => {
    const r = applyOutputCompression(big, { strategy: "summarize" });
    assert.equal(r.compressed, false);
    assert.equal(r.content, big);
  });

  it("truncate-head keeps the TAIL (not the head) and is deterministic", () => {
    const policy = {
      strategy: "truncate-head" as const,
      threshold_bytes: 100,
      target_bytes: 20,
    };
    const r1 = applyOutputCompression(big, policy);
    const r2 = applyOutputCompression(big, policy);
    assert.equal(r1.content, r2.content);
    assert.equal(r1.compressed, true);
    assert.match(r1.content, /^…\[truncated \d+ bytes\] /);
    // The tail survived; the head was dropped.
    assert.ok(r1.content.includes(TAIL), "tail must survive");
    assert.ok(!r1.content.includes(HEAD), "head must be dropped");
    assert.ok(r1.final_bytes < r1.original_bytes);
  });

  it("truncate-tail keeps the HEAD (not the tail) and is deterministic", () => {
    const policy = {
      strategy: "truncate-tail" as const,
      threshold_bytes: 100,
      target_bytes: 20,
    };
    const r1 = applyOutputCompression(big, policy);
    const r2 = applyOutputCompression(big, policy);
    assert.equal(r1.content, r2.content);
    assert.equal(r1.compressed, true);
    assert.match(r1.content, / \[…truncated \d+ bytes\]$/);
    // The head survived; the tail was dropped.
    assert.ok(r1.content.includes(HEAD), "head must survive");
    assert.ok(!r1.content.includes(TAIL), "tail must be dropped");
  });

  it("deduplicate leaves distinct lines unchanged (compressed:false)", () => {
    const distinct = Array.from({ length: 100 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const r = applyOutputCompression(distinct, {
      strategy: "deduplicate",
      threshold_bytes: 50,
    });
    assert.equal(r.content, distinct);
    assert.equal(r.compressed, false);
  });

  it("deduplicate collapses consecutive duplicate lines", () => {
    const input = Array.from({ length: 500 }, () => "warn: same").join("\n");
    const r = applyOutputCompression(input, {
      strategy: "deduplicate",
      threshold_bytes: 100,
    });
    assert.equal(r.compressed, true);
    assert.equal(r.content, "warn: same [×500]");
    // Deterministic.
    const r2 = applyOutputCompression(input, {
      strategy: "deduplicate",
      threshold_bytes: 100,
    });
    assert.equal(r.content, r2.content);
  });

  it("deduplicate preserves order and non-repeated lines", () => {
    const input = ["a", "a", "b", "c", "c", "c"].join("\n").repeat(1);
    const padded = input + "\n" + "z".repeat(200);
    const r = applyOutputCompression(padded, {
      strategy: "deduplicate",
      threshold_bytes: 50,
    });
    assert.match(r.content, /^a \[×2\]\nb\nc \[×3\]/);
  });
});

// ============================================================================
// vocabulary additions
// ============================================================================

describe("sandbox vocabulary defaults", () => {
  it("registers the new kernel-default values", () => {
    const bundle = { name: "test-fixture" } as unknown as Bundle;
    const v = buildVocabularies(bundle);
    assert.ok(v.sandbox_kinds.has("path-restricted"));
    assert.ok(v.sandbox_kinds.has("passthrough"));
    assert.ok(v.error_classes.has("sandbox-violation"));
    assert.ok(v.error_classes.has("tool-output-compressed"));
    assert.ok(v.audit_types.has("tool-call"));
  });
});
