// `loom setup` against a real temp $HOME / project dir — no mocks, no globals.
// A fake server source (a temp stdio.js + temp command files) stands in for
// the installed @loom/mcp-server so these assert the merge / idempotency /
// no-clobber logic precisely; the npm-pack smoke covers real package
// resolution end to end.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import type { CliEnv } from "../src/lib/env.js";
import { setup, type ServerSource } from "../src/commands/setup.js";

interface Captured {
  env: CliEnv;
  out: string[];
  err: string[];
}

function makeEnv(home: string, cwd: string): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const env: CliEnv = { home, cwd, out: (l) => out.push(l), err: (l) => err.push(l) };
  return { env, out, err };
}

function fakeSource(dir: string): ServerSource {
  const stdioPath = join(dir, "server", "dist", "src", "bin", "stdio.js");
  mkdirSync(dirname(stdioPath), { recursive: true });
  writeFileSync(stdioPath, "// fake entrypoint\n", "utf8");
  const commandsSourceDir = join(dir, "server", "cc-adapter", "commands");
  mkdirSync(commandsSourceDir, { recursive: true });
  writeFileSync(join(commandsSourceDir, "task.md"), "TASK COMMAND BODY\n", "utf8");
  writeFileSync(join(commandsSourceDir, "done.md"), "DONE COMMAND BODY\n", "utf8");
  return { stdioPath, commandsSourceDir };
}

interface Harness {
  home: string;
  cwd: string;
  source: ServerSource;
  dispose: () => void;
}

function freshHarness(label: string): Harness {
  const root = mkdtempSync(join(tmpdir(), `loom-setup-${label}-`));
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return {
    home,
    cwd,
    source: fakeSource(root),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

interface McpServerEntry {
  type?: string;
  command?: string;
  args?: string[];
}
function readLoomEntry(configPath: string): McpServerEntry {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    mcpServers?: Record<string, McpServerEntry>;
  };
  const entry = config.mcpServers?.["loom"];
  assert.ok(entry, `expected an mcpServers.loom entry in ${configPath}`);
  return entry;
}

describe("loom setup — fresh install (user scope)", () => {
  it("registers the server with the SQLite flag and installs both commands", () => {
    const h = freshHarness("fresh");
    try {
      const { env, err } = makeEnv(h.home, h.cwd);
      const code = setup([], env, { source: h.source });
      assert.equal(code, 0);
      assert.deepEqual(err, []);

      const configPath = join(h.home, ".claude.json");
      const entry = readLoomEntry(configPath);
      assert.equal(entry.command, "node");
      assert.deepEqual(entry.args, [
        "--experimental-sqlite",
        "--no-warnings",
        h.source.stdioPath,
      ]);

      const taskPath = join(h.home, ".claude", "commands", "task.md");
      const donePath = join(h.home, ".claude", "commands", "done.md");
      assert.equal(readFileSync(taskPath, "utf8"), "TASK COMMAND BODY\n");
      assert.equal(readFileSync(donePath, "utf8"), "DONE COMMAND BODY\n");
    } finally {
      h.dispose();
    }
  });

  it("preserves unrelated keys in an existing config", () => {
    const h = freshHarness("preserve");
    try {
      const configPath = join(h.home, ".claude.json");
      writeFileSync(
        configPath,
        JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }, null, 2),
        "utf8",
      );
      const { env } = makeEnv(h.home, h.cwd);
      assert.equal(setup([], env, { source: h.source }), 0);

      const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      assert.equal(config["theme"], "dark");
      const servers = config["mcpServers"] as Record<string, unknown>;
      assert.ok(servers["other"], "the pre-existing server must survive");
      assert.ok(servers["loom"], "the loom server must be added");
    } finally {
      h.dispose();
    }
  });
});

describe("loom setup — idempotency", () => {
  it("is a no-op on the second run (no duplicate, no rewrite)", () => {
    const h = freshHarness("idempotent");
    try {
      const first = makeEnv(h.home, h.cwd);
      assert.equal(setup([], first.env, { source: h.source }), 0);
      const configPath = join(h.home, ".claude.json");
      const afterFirst = readFileSync(configPath, "utf8");
      const taskAfterFirst = readFileSync(join(h.home, ".claude", "commands", "task.md"), "utf8");

      const second = makeEnv(h.home, h.cwd);
      assert.equal(setup([], second.env, { source: h.source }), 0);
      assert.equal(readFileSync(configPath, "utf8"), afterFirst, "config must be byte-identical");
      assert.equal(
        readFileSync(join(h.home, ".claude", "commands", "task.md"), "utf8"),
        taskAfterFirst,
      );
      assert.ok(
        second.out.some((l) => /already registered/.test(l)),
        "second run should report the registration already present",
      );
      assert.ok(second.out.some((l) => /already installed/.test(l)));
    } finally {
      h.dispose();
    }
  });
});

describe("loom setup — --dry-run", () => {
  it("writes nothing", () => {
    const h = freshHarness("dryrun");
    try {
      const { env, out } = makeEnv(h.home, h.cwd);
      assert.equal(setup(["--dry-run"], env, { source: h.source }), 0);
      assert.ok(!existsSync(join(h.home, ".claude.json")), "no config written");
      assert.ok(!existsSync(join(h.home, ".claude", "commands")), "no commands written");
      assert.ok(out.some((l) => l.startsWith("[dry-run]")), "dry-run output is labelled");
    } finally {
      h.dispose();
    }
  });
});

describe("loom setup — no-clobber", () => {
  it("does not overwrite a locally-edited command without --force", () => {
    const h = freshHarness("noclobber");
    try {
      assert.equal(setup([], makeEnv(h.home, h.cwd).env, { source: h.source }), 0);
      const taskPath = join(h.home, ".claude", "commands", "task.md");
      writeFileSync(taskPath, "MY LOCAL EDIT\n", "utf8");

      const skip = makeEnv(h.home, h.cwd);
      assert.equal(setup([], skip.env, { source: h.source }), 0);
      assert.equal(readFileSync(taskPath, "utf8"), "MY LOCAL EDIT\n", "edit must survive");
      assert.ok(skip.out.some((l) => /locally modified/.test(l)));

      const forced = makeEnv(h.home, h.cwd);
      assert.equal(setup(["--force"], forced.env, { source: h.source }), 0);
      assert.equal(readFileSync(taskPath, "utf8"), "TASK COMMAND BODY\n", "--force overwrites");
    } finally {
      h.dispose();
    }
  });

  it("leaves a divergent registration alone without --force, replaces it with --force", () => {
    const h = freshHarness("divergent");
    try {
      const configPath = join(h.home, ".claude.json");
      writeFileSync(
        configPath,
        JSON.stringify({ mcpServers: { loom: { command: "stale", args: [] } } }, null, 2),
        "utf8",
      );
      const skip = makeEnv(h.home, h.cwd);
      assert.equal(setup([], skip.env, { source: h.source }), 0);
      assert.equal(readLoomEntry(configPath).command, "stale", "divergent entry untouched");
      assert.ok(skip.out.some((l) => /differs/.test(l)));

      const forced = makeEnv(h.home, h.cwd);
      assert.equal(setup(["--force"], forced.env, { source: h.source }), 0);
      assert.equal(readLoomEntry(configPath).command, "node", "--force replaces it");
    } finally {
      h.dispose();
    }
  });
});

describe("loom setup — scope + flag validation", () => {
  it("--project writes .mcp.json + .claude/commands in the project, not HOME", () => {
    const h = freshHarness("project");
    try {
      const { env } = makeEnv(h.home, h.cwd);
      assert.equal(setup(["--project"], env, { source: h.source }), 0);
      assert.ok(existsSync(join(h.cwd, ".mcp.json")), "project config written");
      assert.ok(existsSync(join(h.cwd, ".claude", "commands", "task.md")));
      assert.ok(!existsSync(join(h.home, ".claude.json")), "HOME untouched under --project");
    } finally {
      h.dispose();
    }
  });

  it("rejects --user and --project together", () => {
    const h = freshHarness("conflict");
    try {
      const { env, err } = makeEnv(h.home, h.cwd);
      assert.equal(setup(["--user", "--project"], env, { source: h.source }), 1);
      assert.ok(err.some((l) => /mutually exclusive/.test(l)));
    } finally {
      h.dispose();
    }
  });

  it("rejects an unknown flag", () => {
    const h = freshHarness("badflag");
    try {
      const { env, err } = makeEnv(h.home, h.cwd);
      assert.equal(setup(["--nope"], env, { source: h.source }), 1);
      assert.ok(err.some((l) => /unknown flag --nope/.test(l)));
    } finally {
      h.dispose();
    }
  });
});
