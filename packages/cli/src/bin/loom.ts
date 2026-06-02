#!/usr/bin/env node
// The `loom` executable. Thin: parse argv, dispatch, exit with the command's
// status. All logic lives in `run` so the meta-package's bin shim and the
// tests can drive the same code path without spawning a process.
//
// A few commands — `reset`, `status`, `run`, and `daemon` — open the project's
// SQLite store, which on the pinned Node line is gated behind --experimental-sqlite.
// The flag rides only where SQLite is actually used: the install commands
// (setup / allowlist / init) never open the store and keep a clean,
// flag-free launcher, so those commands re-exec the launcher ONCE with the
// flag. A guard env var prevents an infinite re-exec loop, and a probe
// import skips the re-exec entirely on a Node where node:sqlite is already
// stable.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { run } from "../cli.js";

const SQLITE_COMMANDS = new Set(["reset", "status", "run", "daemon"]);
const REEXEC_GUARD = "LOOM_SQLITE_REEXEC";

function nodeSqliteAvailable(): boolean {
  try {
    createRequire(import.meta.url)("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

function reexecWithSqliteFlag(): number {
  const entry = process.argv[1];
  if (entry === undefined) return 1;
  const res = spawnSync(
    process.execPath,
    ["--experimental-sqlite", "--no-warnings", entry, ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, [REEXEC_GUARD]: "1" } },
  );
  if (typeof res.status === "number") return res.status;
  return 1;
}

async function main(): Promise<number> {
  const command = process.argv[2];
  if (
    command !== undefined &&
    SQLITE_COMMANDS.has(command) &&
    process.env[REEXEC_GUARD] !== "1" &&
    !nodeSqliteAvailable()
  ) {
    return reexecWithSqliteFlag();
  }
  return await run(process.argv.slice(2));
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`loom: ${(err as Error).message}\n`);
    process.exit(1);
  });
