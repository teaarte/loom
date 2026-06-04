#!/usr/bin/env node
// The installed `loom` executable. This meta-package exists so a single
// `npm i -g @loomfsm/pipeline` brings the whole runtime — the CLI, the MCP
// server it registers, the default bundle, and the zero-config provider —
// as co-installed siblings, so `loom setup` can resolve the server's
// entrypoint and the bundle assets resolve at first run.
//
// The dispatch logic lives in @loomfsm/cli; this shim calls the SAME shared
// launcher the CLI's own bin uses, so the two entries cannot drift. `launch`
// awaits the async commands (serve / run / daemon) and re-execs once with
// --experimental-sqlite for the store-touching commands, then exits with the
// command's status.

import { launch } from "@loomfsm/cli";

void launch();
