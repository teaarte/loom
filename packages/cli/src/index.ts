// Public barrel for `@loomfsm/cli`. The meta-package's bin shim imports `run`
// from here; the rest are surfaced so a host embedding the install commands
// can call them directly.

export { run } from "./cli.js";
export { setup } from "./commands/setup.js";
export { allowlistAdd, allowlistList, allowlistFilePath, readAllowlistEntries } from "./commands/allowlist.js";
export { init } from "./commands/init.js";
export { processEnv, type CliEnv } from "./lib/env.js";
export { readCliVersion } from "./version.js";
