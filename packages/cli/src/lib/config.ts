// The bridge from the control layer (`@loomfsm/config`) to the existing
// env-driven knob readers. `loom run` / `daemon` / `serve` resolve notify +
// resilience settings from `LOOM_*` env today; this folds the persisted config
// in as a LOWER-priority layer by deriving a `LOOM_*` overlay and merging it
// UNDER the real environment — so config supplies the defaults and the
// environment still wins. A 0.2.1 user with no config files sees an empty
// overlay and the exact prior behavior.
//
// Only the model map needs a kernel-aware adapter (it rides into the registry
// at build time, in the mcp-server bootstrap); notify + resilience reach their
// existing readers unchanged through this overlay, so nothing in
// `lib/resilience.ts` / `lib/notify.ts` had to change.

import { resolveConfig } from "@loomfsm/config";

import type { CliEnv } from "./env.js";

// Compute the effective environment a command should read for its `LOOM_*`
// knobs: the persisted config's overlay, beaten by the real environment.
export function effectiveEnv(
  projectDir: string,
  env: CliEnv,
  processEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  let overlay: Record<string, string> = {};
  try {
    overlay = resolveConfig({ projectDir, env: processEnv, home: env.home }).envOverlay;
  } catch (err) {
    // A malformed config must not silently swallow a run; surface it on stderr
    // and fall back to the bare environment (the pre-config behavior).
    env.err(`loom: ignoring config (${(err as Error).message})`);
    return processEnv;
  }
  return { ...overlay, ...processEnv };
}
