// Self-contained packaging smoke — proves the published artifact is whole
// without a registry and without the network.
//
// It packs every publishable package with `pnpm pack` (which rewrites the
// workspace: protocol to real versions and applies each package's `files`
// allowlist — the real test of what ships), then extracts the tarballs into a
// throwaway node_modules so the layout matches a global install. Against that
// installed tree it asserts:
//   (a) the `loom` bin runs (`--version`),
//   (b) `loom setup --dry-run` resolves the installed server + commands and
//       prints the intended config without touching the host, and
//   (c) the installed `assembleRegistry` builds a registry whose prompts are
//       materialized and whose context assets carry the bundle's reference
//       catalog — i.e. the bundle's on-disk assets resolved from node_modules.
//
// No npm install runs: `@modelcontextprotocol/sdk` is never loaded by these
// paths, and the one external runtime dep that IS loaded (`zod`, via the
// `@loomfsm/config` leaf the registry build reads) is zero-dependency, so it is
// copied in from the workspace — a faithful, offline stand-in for what `npm i -g`
// would fetch. Extracting the @loomfsm tarballs into one flat node_modules then
// matches a global install.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

// Packages that publish, in dependency order (order is irrelevant to the
// extraction — each tarball is placed by the name in its own package.json —
// but listing them here is the single source of truth for what to pack).
const PUBLISHABLE = [
  "packages/kernel",
  "packages/loader",
  "packages/transport-types",
  "packages/repo-memory",
  "packages/driver",
  "packages/bundles/code",
  "packages/config",
  "packages/providers/claude-code-shuttle",
  "packages/mcp-server",
  "packages/cli",
  "packages/pipeline",
];

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("could not locate the workspace root (pnpm-workspace.yaml)");
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    cwd: opts.cwd,
    env: opts.env ?? process.env,
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// Pack every publishable package into `store`, then extract each tarball into
// `<prefix>/node_modules/<name>` keyed by the name in its own package.json.
function packAndInstall(root: string, store: string, prefix: string): void {
  const nodeModules = join(prefix, "node_modules");
  mkdirSync(nodeModules, { recursive: true });

  for (const rel of PUBLISHABLE) {
    const pkgDir = join(root, rel);
    const packed = run("pnpm", ["pack", "--pack-destination", store], { cwd: pkgDir });
    assert.equal(packed.status, 0, `pnpm pack failed for ${rel}:\n${packed.stderr}`);
  }

  for (const file of readdirSync(store)) {
    if (!file.endsWith(".tgz")) continue;
    const extractDir = mkdtempSync(join(store, "x-"));
    const tarRes = run("tar", ["-xzf", join(store, file), "-C", extractDir]);
    assert.equal(tarRes.status, 0, `tar failed for ${file}:\n${tarRes.stderr}`);
    const pkgPath = join(extractDir, "package", "package.json");
    const name = (JSON.parse(readFileSync(pkgPath, "utf8")) as { name: string }).name;
    const dest = join(nodeModules, ...name.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(join(extractDir, "package"), dest);
  }

  // `@loomfsm/config` carries one real external dep, `zod`, which IS loaded by
  // the registry-build path. zod is zero-dependency, so copy its package dir in
  // from the workspace (dereferencing pnpm's symlink) — the offline equivalent
  // of `npm i` fetching it. Resolve it from the config package's own resolution
  // paths so the lookup is robust to pnpm's (non-root) layout.
  const zodPkgJson = createRequire(import.meta.url).resolve("zod/package.json", {
    paths: [join(root, "packages", "config")],
  });
  cpSync(dirname(zodPkgJson), join(nodeModules, "zod"), { recursive: true, dereference: true });
}

describe("npm pack — self-contained install smoke", () => {
  const root = repoRoot();
  const work = mkdtempSync(join(tmpdir(), "loom-pack-smoke-"));
  const store = join(work, "store");
  const prefix = join(work, "prefix");
  mkdirSync(store, { recursive: true });
  mkdirSync(prefix, { recursive: true });

  const loomBin = join(prefix, "node_modules", "@loomfsm", "pipeline", "bin", "loom.js");

  // One install for all three assertions; packing + building the publishable
  // set is the slow part, so the heavy setup happens once. `prepack` rebuilds each
  // package's dist as it is packed, so no pre-build step is assumed.
  before(() => packAndInstall(root, store, prefix), { timeout: 300_000 });
  after(() => rmSync(work, { recursive: true, force: true }));

  it("the @loomfsm/pipeline tarball declares no unresolved workspace: deps", () => {
    const pkg = JSON.parse(
      readFileSync(join(prefix, "node_modules", "@loomfsm", "pipeline", "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    for (const [dep, range] of Object.entries(pkg.dependencies)) {
      assert.ok(!range.includes("workspace:"), `${dep} still carries a workspace: range`);
    }
  });

  it("(a) the installed loom bin runs --version", { timeout: 240_000 }, () => {
    assert.ok(existsSync(loomBin), `expected the loom bin at ${loomBin}`);
    const res = run(process.execPath, [loomBin, "--version"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  it("(b) loom setup --dry-run resolves the installed server + commands, writes nothing", () => {
    const fakeHome = join(work, "home");
    mkdirSync(fakeHome, { recursive: true });
    const env = { ...process.env, HOME: fakeHome };
    const res = run(process.execPath, [loomBin, "setup", "--dry-run"], { env });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /register MCP server 'loom'/);
    assert.match(res.stdout, /install command \/task/);
    assert.match(res.stdout, /no changes written/);
    // The dry run must not have touched the host.
    assert.ok(!existsSync(join(fakeHome, ".claude.json")), "dry-run wrote a config");
    assert.ok(!existsSync(join(fakeHome, ".claude")), "dry-run created .claude/");
  });

  it("(c) the installed assembleRegistry materializes prompts + the bundle's refs catalog", () => {
    // Probe script lives inside the prefix so it resolves @loomfsm/* from the
    // installed node_modules, exactly as a consumer's code would.
    const probePath = join(prefix, "probe.mjs");
    writeFileSync(
      probePath,
      [
        'import { assembleRegistry } from "@loomfsm/mcp-server/bootstrap";',
        "const projectDir = process.argv[2];",
        "const reg = await assembleRegistry(projectDir);",
        "const assets = reg.context_assets ?? [];",
        "const blob = assets.map((a) => `${a.heading}\\n${a.body}`).join(\"\\n\");",
        "console.log(JSON.stringify({",
        "  promptsSize: reg.prompts ? reg.prompts.size : 0,",
        "  assetCount: assets.length,",
        "  hasRefsCatalog: /knowledge\\/references\\//.test(blob),",
        "}));",
      ].join("\n"),
      "utf8",
    );

    const projectDir = join(work, "probe-project");
    mkdirSync(projectDir, { recursive: true });

    const res = run(process.execPath, [
      "--experimental-sqlite",
      "--no-warnings",
      probePath,
      resolve(projectDir),
    ]);
    assert.equal(res.status, 0, `probe failed:\n${res.stderr}`);
    const summary = JSON.parse(res.stdout.trim()) as {
      promptsSize: number;
      assetCount: number;
      hasRefsCatalog: boolean;
    };
    assert.ok(summary.promptsSize > 0, "registry.prompts must be materialized from the bundle");
    assert.ok(
      summary.hasRefsCatalog,
      "registry.context_assets must carry the bundle's reference catalog",
    );
  });
});
