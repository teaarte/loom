// Redaction for control-layer documents on a READ path, and its WRITE-path
// inverse.
//
// `config.json` is meant to hold secrets by REFERENCE (`secret:<name>`), never a
// literal — but the CLI permits a literal notify token, so every GET masks a
// literal secret-bearing field. A `secret:<name>` ref is NOT a secret (it is a
// pointer that reveals nothing) and is shown verbatim; the raw value lives only
// in secrets.json.
//
// `reconcileMaskedConfig` is the inverse used on PUT: a form that echoes a masked
// value back (the user did not change it) must NOT overwrite the stored literal
// with stars — so an incoming value equal to the mask of the stored value is
// replaced by the stored value. A genuine edit (any other string) is taken as the
// new value.

import { isSecretRef, maskSecret } from "./secrets.js";
import type { LoomConfig } from "./types.js";

// Config paths whose LITERAL value is a secret to mask on read. A `secret:<name>`
// reference at any of these is left intact. Add a path here when a new
// secret-bearing literal field lands.
const SENSITIVE_PATHS: readonly (readonly string[])[] = [
  ["notify", "telegram_token"],
  ["notify", "webhook_url"],
  ["notify", "slack_url"],
];

function readAt(obj: Record<string, unknown>, path: readonly string[]): string | undefined {
  let cur: unknown = obj;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return typeof cur === "string" ? cur : undefined;
}

// Set a leaf value only when its parent object already exists (the callers only
// ever write where `readAt` already found a string, so the parent is present).
function writeAt(obj: Record<string, unknown>, path: readonly string[], value: string): void {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i] as string;
    const nxt = cur[seg];
    if (nxt === null || typeof nxt !== "object") return;
    cur = nxt as Record<string, unknown>;
  }
  cur[path[path.length - 1] as string] = value;
}

// Mask every literal secret in a config for display. Returns a deep clone; the
// input is untouched. A `secret:` ref or an absent field is left as-is.
export function maskConfig(config: LoomConfig): LoomConfig {
  const clone = structuredClone(config) as Record<string, unknown>;
  for (const path of SENSITIVE_PATHS) {
    const v = readAt(clone, path);
    if (v !== undefined && v.length > 0 && !isSecretRef(v)) writeAt(clone, path, maskSecret(v));
  }
  return clone as LoomConfig;
}

// WRITE-path inverse of `maskConfig`: where an incoming value equals the mask of
// the stored value, the user did not edit it — keep the stored literal so a
// round-trip never clobbers a secret with stars. Returns a deep clone of
// `incoming` with those fields restored.
export function reconcileMaskedConfig(incoming: LoomConfig, stored: LoomConfig): LoomConfig {
  const clone = structuredClone(incoming) as Record<string, unknown>;
  const storedObj = stored as unknown as Record<string, unknown>;
  for (const path of SENSITIVE_PATHS) {
    const inc = readAt(clone, path);
    const prev = readAt(storedObj, path);
    if (inc !== undefined && prev !== undefined && prev.length > 0 && inc === maskSecret(prev)) {
      writeAt(clone, path, prev);
    }
  }
  return clone as LoomConfig;
}
