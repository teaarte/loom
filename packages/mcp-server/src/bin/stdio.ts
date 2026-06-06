#!/usr/bin/env node
// Stdio entrypoint a host's MCP config spawns. Connects the server over
// stdin/stdout and exits non-zero if the transport fails to connect.
//
// This is where the production dependencies wire in: `assembleRegistry`
// loads the installed bundle + the zero-config shuttle provider for a
// project (so the active-task tools have a real flow to tick), and the
// operator-authored project-dir allowlist gates which projects are
// reachable. The allowlist is default-deny — a project is permitted only
// after its absolute path is added to the file (see SETUP.md). This
// entrypoint ensures the file and its parent directory exist so the
// operator has a place to add entries, but it NEVER auto-enrolls a
// project: a self-enrolling transport would defeat the gate.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { userFootprintDir } from "@loomfsm/kernel";

import { assembleRegistry } from "../bootstrap.js";
import { runStdioServer } from "../server.js";

// Mirror the kernel's default allowlist location so the path the gate
// reads and the path this entrypoint seeds are the same file.
function resolveAllowlistPath(): string {
  return join(userFootprintDir(), "projects.allow");
}

function ensureAllowlistExists(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // `wx` creates the file only when it is absent — an operator-authored
    // allowlist is never overwritten.
    writeFileSync(path, "", { flag: "wx" });
  } catch {
    // Already present (the common case) or unwritable; either way the
    // gate treats a missing/empty file as default-deny.
  }
}

const allowlistPath = resolveAllowlistPath();
ensureAllowlistExists(allowlistPath);

runStdioServer({ resolveRegistry: assembleRegistry, allowlistPath }).catch((err: unknown) => {
  process.stderr.write(`mcp-server failed to start: ${String(err)}\n`);
  process.exit(1);
});
