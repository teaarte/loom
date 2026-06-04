// The argv dispatcher: --version / --help / unknown command, plus the
// allowlist subcommand routing. The command bodies are covered in their own
// suites; this only asserts the routing + the top-level flags.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { run } from "../src/cli.js";
import type { CliEnv } from "../src/lib/env.js";
import { readCliVersion } from "../src/version.js";

function makeEnv(): { env: CliEnv; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const env: CliEnv = {
    home: "/tmp/nonexistent-home",
    cwd: "/tmp/nonexistent-cwd",
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { env, out, err };
}

describe("loom dispatcher", () => {
  it("--version prints the package version", () => {
    const { env, out } = makeEnv();
    assert.equal(run(["--version"], env), 0);
    assert.deepEqual(out, [readCliVersion()]);
  });

  it("--help / -h / help print usage", () => {
    for (const argv of [["--help"], ["-h"], ["help"]]) {
      const { env, out } = makeEnv();
      assert.equal(run(argv, env), 0);
      assert.ok(out.join("\n").includes("loom setup"), "usage lists the commands");
    }
  });

  it("an unknown command exits 1 with guidance", () => {
    const { env, err } = makeEnv();
    assert.equal(run(["frobnicate"], env), 1);
    assert.ok(err.some((l) => /unknown command/.test(l)));
  });

  it("allowlist with a bad subcommand exits 1", () => {
    const { env, err } = makeEnv();
    assert.equal(run(["allowlist", "wat"], env), 1);
    assert.ok(err.some((l) => /expected 'add' or 'list'/.test(l)));
  });
});
