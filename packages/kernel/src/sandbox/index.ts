// Sandbox surface: the path-discipline core, the two built-in plugins, the
// deterministic output compressor, and the default-selection function.

import type { SandboxKind, SandboxPlugin } from "../types/plugins.js";

import { createPassthroughSandbox } from "./passthrough.js";
import type { PassthroughSandboxOptions } from "./passthrough.js";
import { createPathRestrictedSandbox } from "./path-restricted.js";

export * from "./resolve-safe-path.js";
export * from "./output-compression.js";
export { createPathRestrictedSandbox } from "./path-restricted.js";
export { createPassthroughSandbox } from "./passthrough.js";
export type { PassthroughSandboxOptions } from "./passthrough.js";

export interface ResolveSandboxOptions {
  // Project root the path-restricted boundary binds its path discipline to.
  projectDir: string;
  // Audit sink for passthrough's startup warning (ignored by path-restricted).
  audit_emit?: PassthroughSandboxOptions["audit_emit"];
}

// Default-selection: with no kind configured the boundary is
// `path-restricted` — the safe cross-platform default. `passthrough` (no
// isolation) is returned ONLY when explicitly named, so a run never loses
// its boundary by omission. Full config-file parsing is a separate layer;
// this is the in-code function that layer will call.
export function resolveSandbox(
  kind: SandboxKind | undefined,
  opts: ResolveSandboxOptions,
): SandboxPlugin {
  if (kind === "passthrough") {
    return createPassthroughSandbox({ audit_emit: opts.audit_emit });
  }
  return createPathRestrictedSandbox(opts.projectDir);
}
