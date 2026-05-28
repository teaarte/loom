// `defineBundle` — typed identity helper for bundle authors.
//
// Bundle packages call `export default defineBundle({...})` to get the
// full `Bundle` type-narrowing surface inside the object literal at
// compile time (stage-name typos, missing required fields, invalid
// `kind` discriminant on a Stage entry all surface during build, not
// later when the loader rejects the bundle at runtime). One-line body —
// the value at runtime is the identical object the author passed in.

import type { Bundle } from "./types/bundle.js";

export function defineBundle(b: Bundle): Bundle {
  return b;
}
