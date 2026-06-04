#!/usr/bin/env node
// The `loom` executable. Thin: hand off to the shared launcher, which parses
// argv, re-execs once with --experimental-sqlite for store-touching commands,
// dispatches through `run`, and exits with the command's status. The
// meta-package's bin shim calls the SAME `launch()` so the two entries cannot
// drift.

import { launch } from "../launch.js";

void launch();
