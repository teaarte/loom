// Path-discipline core for project-scoped file tools.
//
// An agent runs LLM-generated instructions; a confabulated or
// injection-supplied path could ask to read `/etc/shadow`, `~/.ssh/id_rsa`,
// or escape the project via a symlink. `resolveSafePath` resolves a
// caller-supplied path against the project directory, follows symlinks
// BEFORE the membership check (so a link that points outside is judged on
// its real target, not its in-project name), and refuses both
// out-of-project paths and a sensitive-path blocklist.
//
// TWO RINGS, DIFFERENT JOBS:
//   1. The escape check is the primary, false-positive-free guard for
//      everything OUTSIDE the project — `~/.ssh`, `/etc`, `~/.aws`, OS
//      keychains all resolve outside `projectDir` and are refused as
//      `path-escapes-project`. This is what stops an agent reaching an
//      operating-system credential folder.
//   2. The blocklist is the SECOND ring, for secrets that live INSIDE the
//      project tree (a vendored / symlinked / mistakenly-committed `.ssh`,
//      a checked-in `.env`). It is matched as a substring of the resolved
//      path, so its directory tokens are deliberately dot-prefixed
//      (`/.ssh/`, not `/ssh/`) — a bare `dev/` or `var/` token would
//      false-positive on ordinary project folders of the same name.
//
// The kernel default set is DOMAIN-NEUTRAL — only universally-sensitive
// credential stores and secret files. Ecosystem-specific entries
// (`.npmrc`, `terraform.tfvars`, `~/.kube`, …) are contributed additively
// by the active bundle/provider via `mergeSensitivePathRules`, the same
// kernel-default-plus-extension shape the vocabulary registry uses.
//
// What this blocklist is and isn't: it is an anti-typo / anti-accidental
// guard for honest tool calls, NOT an exfiltration boundary — a motivated
// caller can still reach an in-project file whose path doesn't trip a
// pattern. Process-level isolation is the real exfil boundary; this is the
// cheap inner ring. The function never throws on a refused path — it
// returns a discriminated result so callers render a reason instead of
// catching.

import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

export type SafePathResult =
  | { ok: true; path: string }
  | { ok: false; reason: string };

// A blocklist contribution. `dirs` are matched as substrings of the
// resolved path (dot-prefix them to avoid colliding with ordinary folder
// names); `filePatterns` are matched against the resolved path.
export interface SensitivePathRules {
  readonly dirs: readonly string[];
  readonly filePatterns: readonly RegExp[];
}

// Domain-neutral credential STORES that are sensitive regardless of what
// the pipeline is used for. Dot-prefixed so they never match an ordinary
// in-project folder (`dev/`, `var/`, `config/`). The OS-level copies of
// these live outside the project and are already caught by the escape
// check; these tokens are the in-project second ring.
export const KERNEL_SENSITIVE_DIRS: readonly string[] = [
  "/.ssh/", // SSH private keys / known_hosts
  "/.gnupg/", // GPG keyring
  "/.aws/", // AWS credentials + config
  "/.azure/", // Azure CLI tokens
  "/.gcp/", // Google Cloud key material
  "/.config/gcloud/", // gcloud CLI credential store
  "/.config/git/", // git credential store
];

// Domain-neutral secret-bearing FILENAMES. Matched on a segment boundary so
// `.env` / `.env.local` / `.env.production` all trip, but an unrelated
// `my.env.notes` does not. Ecosystem-specific files (`.npmrc`, `.pypirc`,
// `terraform.tfvars`, kube config) are NOT here — a bundle contributes them.
export const KERNEL_SENSITIVE_FILE_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env($|\.)/, // .env, .env.local, .env.production
  /(^|\/)\.envrc$/, // direnv
  /(^|\/)\.netrc$/, // unix machine credentials
  /(^|\/)\.pgpass$/, // password file
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)($|\.)/, // SSH private keys
  /(^|\/)credentials(\.json)?$/, // generic credential dump
  /(^|\/)secrets?(\.json|\.yaml|\.yml)?$/, // generic secret store
  /(^|\/)service[-_]?account[-_]?key(\.json)?$/, // cloud service-account keys
];

// The kernel baseline as a single ruleset. A bundle/provider merges its
// domain rules on top via `mergeSensitivePathRules`.
export const KERNEL_SENSITIVE_PATH_RULES: SensitivePathRules = {
  dirs: KERNEL_SENSITIVE_DIRS,
  filePatterns: KERNEL_SENSITIVE_FILE_PATTERNS,
};

// Kernel-default-plus-extension merge, mirroring the vocabulary registry:
// the baseline is always present (fail-safe floor), extensions append.
export function mergeSensitivePathRules(
  base: SensitivePathRules,
  ...extensions: readonly SensitivePathRules[]
): SensitivePathRules {
  const dirs = [...base.dirs];
  const filePatterns = [...base.filePatterns];
  for (const ext of extensions) {
    dirs.push(...ext.dirs);
    filePatterns.push(...ext.filePatterns);
  }
  return { dirs, filePatterns };
}

export async function resolveSafePath(
  input: string,
  projectDir: string,
  rules: SensitivePathRules = KERNEL_SENSITIVE_PATH_RULES,
): Promise<SafePathResult> {
  // Canonicalize the project root first. On platforms where the workspace
  // lives under a symlinked temp root (e.g. macOS `/var` → `/private/var`),
  // resolving the input against the canonical root keeps a not-yet-existing
  // target's fallback path on the same canonical prefix as the base.
  const projectReal = await realpath(resolve(projectDir)).catch(() =>
    resolve(projectDir),
  );

  const abs = resolve(projectReal, input);

  // Follow symlinks before judging escape. A not-yet-existing target (a
  // `file_write` to a new file) has no realpath of its own, so we
  // canonicalize the LONGEST EXISTING ANCESTOR and re-append the missing
  // remainder. Trusting the lexical path here would preserve the in-project
  // *name* of a symlinked intermediate directory; canonicalizing the
  // existing ancestor instead resolves that symlink to its real (outside)
  // target, where the containment check below catches it. A genuinely-new
  // in-project file keeps the canonical in-project prefix and is allowed.
  const real = await canonicalizeLongestExistingAncestor(abs);

  // Require a true path-segment boundary: a bare `startsWith` would let
  // `<root>-evil/` masquerade as inside `<root>`. This is also the guard
  // that refuses every OS credential folder outside the project.
  if (real !== projectReal && !real.startsWith(projectReal + sep)) {
    return { ok: false, reason: "path-escapes-project" };
  }

  for (const dir of rules.dirs) {
    if (real.includes(dir)) return { ok: false, reason: `sensitive-dir:${dir}` };
  }
  for (const re of rules.filePatterns) {
    if (re.test(real)) return { ok: false, reason: `sensitive-file:${re.source}` };
  }

  return { ok: true, path: real };
}

// Canonicalize the longest existing ancestor of an absolute path and
// re-append the non-existent remainder. When the full path already exists
// (a file or a symlink), this is just its `realpath`. When the leaf — or a
// deeper segment — does not exist yet, walk up to the first ancestor that
// does, `realpath` THAT (collapsing any symlinked directory in the chain to
// its real target), then rejoin the missing tail. The escape check then
// judges a new file by where its real parent actually lives, never by the
// in-project name of a symlinked intermediate directory.
async function canonicalizeLongestExistingAncestor(
  abs: string,
): Promise<string> {
  const tail: string[] = [];
  let probe = abs;
  for (;;) {
    const real = await realpath(probe).catch(() => null);
    if (real !== null) {
      return tail.length === 0 ? real : join(real, ...tail);
    }
    const parent = dirname(probe);
    if (parent === probe) {
      // Reached the filesystem root without finding an existing ancestor.
      // The root always exists, so this is unreachable in practice;
      // returning the lexical path keeps the containment check meaningful
      // rather than throwing from a path-resolution helper.
      return abs;
    }
    tail.unshift(basename(probe));
    probe = parent;
  }
}
