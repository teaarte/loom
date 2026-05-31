#!/usr/bin/env node
// The `loom` executable. Thin: parse argv, dispatch, exit with the command's
// status. All logic lives in `run` so the meta-package's bin shim and the
// tests can drive the same code path without spawning a process.

import { run } from "../cli.js";

try {
  process.exit(run(process.argv.slice(2)));
} catch (err) {
  process.stderr.write(`loom: ${(err as Error).message}\n`);
  process.exit(1);
}
