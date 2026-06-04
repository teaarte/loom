// Client-side mirror of the server's secret masking, used ONLY to recognise a
// masked value the UI received — never to reconstruct a raw one. The server is
// the authority: every GET that could carry a secret returns it masked, and a
// PUT that echoes a masked value back is reconciled to the stored literal
// server-side (so an unchanged field never clobbers a secret with stars). These
// helpers let a form mark a field as "already a stored secret" and assert, in
// tests, that nothing rendered is a raw value.
//
// Pure (no DOM) so it is node-testable.

// Mask a value exactly as the server does (`maskSecret`): reveal at most the
// last 4 characters, the rest as stars. Kept in lockstep with the server helper
// so a round-tripped masked value compares equal and is preserved on write.
export function maskSecret(value: string): string {
  if (value.length <= 4) return "*".repeat(value.length);
  return `${"*".repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`;
}

// Whether a string looks like a masked secret the server produced: a run of one
// or more leading stars, then up to 4 non-star tail characters, with no star in
// the tail. A `secret:<name>` reference is NOT masked (it is a pointer that
// reveals nothing) and is shown verbatim, so it must read as not-masked here.
export function isMaskedSecret(value: string): boolean {
  if (value.length === 0) return false;
  return /^\*+[^*]{0,4}$/.test(value);
}
