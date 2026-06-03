// Secrets — global, by-REFERENCE, masked on read.
//
// A config file references a secret by NAME and never holds the literal value;
// the value lives only in secrets.json (chmod 600) or the environment. This is
// the indirection that keeps a token out of anything a user might commit, copy,
// or paste.
//
// `resolveSecret` is the one read path that returns a RAW value, and only at the
// point of use (e.g. building an executor's credentials, a later phase). Every
// listing/display path uses `maskSecret` instead — no verb ever prints a full
// secret.

import { readSecrets } from "./stores.js";

// A config string value of this form is a secret reference, resolved from
// secrets.json (then the environment) rather than used literally.
const SECRET_REF_PREFIX = "secret:";

export function isSecretRef(value: string): boolean {
  return value.startsWith(SECRET_REF_PREFIX);
}

export function secretRefName(value: string): string {
  return value.slice(SECRET_REF_PREFIX.length);
}

// Resolve a secret by name: secrets.json first, then the environment (so CI /
// one-shot runs inject a value without writing a file — the same "env beats
// file" posture the config layers take). Returns undefined when neither has it.
export function resolveSecret(
  name: string,
  loomHome: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const fromFile = readSecrets(loomHome)[name];
  if (fromFile !== undefined && fromFile.length > 0) return fromFile;
  const fromEnv = env[name];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return undefined;
}

// Resolve a possibly-referenced config value: a `secret:<name>` ref is looked up
// (an unresolved ref yields undefined — the caller decides whether that channel
// is configured); a literal is returned as-is.
export function resolveMaybeRef(
  value: string,
  loomHome: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (isSecretRef(value)) return resolveSecret(secretRefName(value), loomHome, env);
  return value;
}

// Mask a secret for display: never reveal more than the last 4 characters.
export function maskSecret(value: string): string {
  if (value.length <= 4) return "*".repeat(value.length);
  return `${"*".repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`;
}
