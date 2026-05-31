#!/usr/bin/env node
// The installed `loom` executable. This meta-package exists so a single
// `npm i -g @loom/pipeline` brings the whole runtime — the CLI, the MCP
// server it registers, the default bundle, and the zero-config provider —
// as co-installed siblings, so `loom setup` can resolve the server's
// entrypoint and the bundle assets resolve at first run. The dispatch logic
// itself lives in @loom/cli; this is a thin shim.

import { run } from "@loom/cli";

try {
  process.exit(run(process.argv.slice(2)));
} catch (err) {
  process.stderr.write(`loom: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
