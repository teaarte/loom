// Minimal argv splitter — separates `--flag` tokens from positionals so the
// subcommands stay dependency-free (no commander/meow). Only the boolean
// flags this install surface needs are recognized; an unknown `--flag`
// surfaces so the caller can reject it rather than silently swallow a typo.

export interface ParsedArgs {
  positionals: string[];
  flags: Set<string>;
}

// Split argv into positionals + the set of `--flag` names seen (leading `--`
// stripped). `-x` short flags are treated the same way (leading dashes
// stripped). A bare `--` terminates flag parsing; everything after is
// positional.
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Set<string>();
  let flagsDone = false;
  for (const token of argv) {
    if (!flagsDone && token === "--") {
      flagsDone = true;
      continue;
    }
    if (!flagsDone && token.startsWith("-")) {
      flags.add(token.replace(/^-+/, ""));
      continue;
    }
    positionals.push(token);
  }
  return { positionals, flags };
}

// The set of flags a command declares it understands. Any other `--flag`
// is a usage error — returns the first unknown flag, or null when clean.
export function firstUnknownFlag(flags: Set<string>, known: readonly string[]): string | null {
  for (const flag of flags) {
    if (!known.includes(flag)) return flag;
  }
  return null;
}
