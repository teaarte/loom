// Reads the CLI's own published version off its package.json so
// `loom --version` reports the installed release without a generated
// constant drifting out of sync. The file lives at <pkg>/dist/src/version.js
// after compile and <pkg>/src/version.ts in dev; the package root sits three
// (compiled) or two (source) levels up, where package.json sits.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function readCliVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "..", "..", "package.json"), // dist/src/version.js
    resolve(here, "..", "..", "package.json"), // src/version.ts
  ];
  for (const path of candidates) {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version === "string") return parsed.version;
    } catch {
      // try the next candidate
    }
  }
  return "0.0.0";
}
