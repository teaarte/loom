// Shared SQL string-literal scanner — the one routine that walks past a
// single-quoted SQL literal honoring the `''` escape.
//
// Three call sites in the restore/backup path need this so a `;`, `,`, or `)`
// INSIDE a string value is not mistaken for a delimiter: `splitStatements` and
// `splitListItems` (which accumulate the literal into their buffer) and
// `matchParen` (which only needs to skip it for depth counting). The scan is
// security-relevant — it is part of how a restored SQL dump is parsed before
// the DDL allowlist runs — so the three copies MUST behave identically. They
// did, by hand; this makes that one routine, removing the drift risk.
//
// Pure string arithmetic — no clock, no I/O.

// Advance past a single-quoted SQL string literal. `i` MUST point at the
// opening quote. Returns the index just PAST the closing quote (the `''`
// escape stays inside the literal), or the string length when the literal is
// unterminated. The opening/closing quotes are part of the consumed span, so a
// caller accumulating text takes `s.slice(start, scanStringLiteral(s, start))`.
export function scanStringLiteral(s: string, i: number): number {
  const n = s.length;
  i += 1; // skip the opening quote
  while (i < n) {
    const c = s[i] as string;
    i += 1;
    if (c === "'") {
      // A doubled quote is an escaped quote, not the terminator — keep going.
      if (i < n && s[i] === "'") {
        i += 1;
        continue;
      }
      break;
    }
  }
  return i;
}
