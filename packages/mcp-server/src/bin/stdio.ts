#!/usr/bin/env node
// Stdio entrypoint a host's MCP config spawns. Connects the server over
// stdin/stdout and exits non-zero if the transport fails to connect.
//
// No registry is injected here, so the active-task tools answer with a
// structured REGISTRY_UNAVAILABLE envelope rather than crash; the
// read-only tools work as-is. Production registry assembly (loading the
// enabled bundle from disk) wires in through a separate entrypoint.

import { runStdioServer } from "../server.js";

runStdioServer().catch((err: unknown) => {
  process.stderr.write(`mcp-server failed to start: ${String(err)}\n`);
  process.exit(1);
});
