// Dev-ecosystem sensitive-path rules contributed by the code bundle.
//
// The substrate's path-discipline floor is deliberately domain-neutral —
// it knows about universally-sensitive credential stores (`~/.ssh`,
// `.env`, cloud credential dirs) but NOT about the secret files a
// software project carries. Those belong to whoever owns the domain.
//
// This ruleset is the code bundle's contribution, merged onto the kernel
// floor via `mergeSensitivePathRules` when the per-task tool context is
// assembled. Two rings, same shape the substrate uses:
//   - `dirs` are matched as substrings of the resolved path, so each token
//     is dot/slash-anchored to avoid colliding with an ordinary project
//     folder of the same name.
//   - `filePatterns` are RegExps tested against the resolved path, anchored
//     on a segment boundary so a leading-dot secret name trips but an
//     unrelated longer name does not.
//
// Anti-typo guard, not an exfil boundary: a motivated caller can still
// reach an in-project file whose name dodges every pattern. Process-level
// isolation is the real boundary; this is the cheap inner ring that stops
// an LLM-confabulated or injection-supplied path from reading a package
// registry token or an infra credential by accident.

import type { SensitivePathRules } from "@loom/kernel";

export const CODE_BUNDLE_SENSITIVE_PATH_RULES: SensitivePathRules = {
  dirs: [
    "/.kube/", // kubeconfig + cluster client certs
    "/.docker/", // registry auth (config.json holds base64 creds)
    "/.config/gh/", // GitHub CLI host tokens
  ],
  filePatterns: [
    /(^|\/)\.npmrc$/, // npm registry auth token (_authToken)
    /(^|\/)\.pypirc$/, // PyPI upload credentials
    /(^|\/)[^/]*\.tfvars$/, // Terraform variables — terraform.tfvars and friends carry secrets
    /kubectl[/_]?config/, // a kubectl config dropped outside ~/.kube
    // `.pgpass` is also on the kernel floor; carried here too so the code
    // bundle's ruleset reads as a complete dev-ecosystem set on its own.
    // The merge is additive, so the duplicate is a harmless second check.
    /(^|\/)\.pgpass$/,
  ],
};
