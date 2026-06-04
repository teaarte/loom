// Packaging smoke for the web layer — proves two load-bearing invariants on the
// REAL published artifacts (via `pnpm pack`, which applies each package's `files`
// allowlist and rewrites workspace: ranges):
//
//   • `@loomfsm/dashboard` ships ONLY its prebuilt `dist/` (no src, no config) —
//     the SPA the server serves verbatim, with no runtime dependency of its own.
//   • `@loomfsm/server` keeps a workspace-ONLY runtime dependency graph: every
//     `dependencies` entry is an `@loomfsm/*` package (the dashboard among them),
//     and no UI framework (react / vite) ever reaches a consumer's runtime.
//
// A fast static check on the source package.jsons runs first (no build); the
// real `pnpm pack` then confirms the tarball contents match.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("could not locate the workspace root");
}

interface PkgJson {
  name: string;
  files?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPkg(path: string): PkgJson {
  return JSON.parse(readFileSync(path, "utf8")) as PkgJson;
}

const ROOT = repoRoot();

describe("web layer — static dependency posture", () => {
  it("the dashboard ships only dist and carries NO runtime dependency", () => {
    const pkg = readPkg(join(ROOT, "packages", "dashboard", "package.json"));
    assert.deepEqual(pkg.files, ["dist"], "dashboard must publish only dist/");
    assert.equal(
      pkg.dependencies === undefined || Object.keys(pkg.dependencies).length === 0,
      true,
      "the dashboard must declare no runtime dependencies (react/vite are dev-only)",
    );
    // react / vite live in devDependencies — never shipped to a consumer.
    assert.ok(pkg.devDependencies?.["react"], "react is a dev dependency");
    assert.ok(pkg.devDependencies?.["vite"], "vite is a dev dependency");
  });

  it("the server's runtime deps are workspace-only (no UI framework)", () => {
    const pkg = readPkg(join(ROOT, "packages", "server", "package.json"));
    const deps = pkg.dependencies ?? {};
    for (const name of Object.keys(deps)) {
      assert.ok(name.startsWith("@loomfsm/"), `server runtime dep '${name}' is not a workspace package`);
    }
    assert.ok(deps["@loomfsm/dashboard"], "server depends on the dashboard (to serve its dist)");
    for (const banned of ["react", "react-dom", "vite", "@vitejs/plugin-react"]) {
      assert.ok(!(banned in deps), `server must not have '${banned}' as a runtime dependency`);
    }
  });
});

describe("web layer — pnpm pack", () => {
  const work = mkdtempSync(join(tmpdir(), "loom-web-pack-"));

  function pack(pkgRel: string): { tarball: string; pkg: PkgJson } {
    const res = spawnSync("pnpm", ["pack", "--pack-destination", work], {
      cwd: join(ROOT, pkgRel),
      encoding: "utf8",
    });
    assert.equal(res.status, 0, `pnpm pack failed for ${pkgRel}:\n${res.stderr}`);
    const tgz = readdirSync(work).filter((f) => f.endsWith(".tgz"));
    // The most recently written tarball for this package.
    const tarball = join(work, tgz[tgz.length - 1] as string);
    const pkgJson = spawnSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" });
    assert.equal(pkgJson.status, 0, `could not read package.json from ${tarball}:\n${pkgJson.stderr}`);
    return { tarball, pkg: JSON.parse(pkgJson.stdout) as PkgJson };
  }

  function fileList(tarball: string): string[] {
    const res = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout.split(/\r?\n/).filter((l) => l.length > 0 && !l.endsWith("/"));
  }

  after(() => rmSync(work, { recursive: true, force: true }));

  it("the dashboard tarball contains only dist + package metadata", { timeout: 180_000 }, () => {
    const { tarball } = pack("packages/dashboard");
    const files = fileList(tarball).map((f) => f.replace(/^package\//, ""));
    assert.ok(files.includes("package.json"));
    assert.ok(
      files.some((f) => f.startsWith("dist/")),
      "the tarball must carry the built dist/",
    );
    const stray = files.filter((f) => f !== "package.json" && !/^dist\//.test(f) && !/^(README|LICENSE)/i.test(f));
    assert.deepEqual(stray, [], `unexpected non-dist files shipped: ${stray.join(", ")}`);
  });

  it("the server tarball declares resolved workspace-only deps", { timeout: 180_000 }, () => {
    const { pkg } = pack("packages/server");
    const deps = pkg.dependencies ?? {};
    for (const [name, range] of Object.entries(deps)) {
      assert.ok(name.startsWith("@loomfsm/"), `packed server dep '${name}' is not a workspace package`);
      assert.ok(!range.includes("workspace:"), `'${name}' still carries a workspace: range in the tarball`);
    }
    for (const banned of ["react", "vite", "@vitejs/plugin-react"]) {
      assert.ok(!(banned in deps), `packed server must not depend on '${banned}'`);
    }
  });
});
