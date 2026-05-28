// `defineManifest` — typed identity helper for extension authors.
//
// Extension packages call `export default defineManifest({...})` to get
// the full `ExtensionManifest` type-narrowing surface inside the object
// literal at compile time (display_name typos, missing required fields,
// invalid `kind` discriminator all surface during build, not later when
// the loader rejects the manifest at runtime). One-line body — the
// value at runtime is the identical object the author passed in.

import type { ExtensionManifest } from "./types/extension.js";

export function defineManifest(m: ExtensionManifest): ExtensionManifest {
  return m;
}
