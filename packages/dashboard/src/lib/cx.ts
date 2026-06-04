// Compose class names, dropping falsy parts. CSS-module class lookups are typed
// `string | undefined` under `noUncheckedIndexedAccess`; this keeps a missing key
// from leaking the literal "undefined" into a className.
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" ");
}
