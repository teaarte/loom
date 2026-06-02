// Server domain-leak gate.
//
// The control plane is bundle- and domain-BLIND: it wraps the generic
// `drive()` loop (through the daemon's supervisor) and reasons only about
// counts, time, status, and error codes — never a domain's vocabulary. In
// particular it must not read the code-domain `stack` (the bundle owns it in
// `bundle_state.stack`; an agent learns its toolchain from the PROMPT, not a
// control-plane-side read). If the server ever reached for `StackInfo` or a
// `.stack` field, the D1 separation the driver and daemon hold would silently
// unwind one layer further out.
//
// This is the load-bearing grep, run on `packages/server/src`:
//   grep -rnE "StackInfo|\.stack\b" packages/server/src   →  must be empty
//
// Mirrors the daemon/driver gate exactly, including avoiding `err.stack` in
// src (error logging uses `.message` / `String(err)`), so the same reviewer
// grep stays clean across every transport.

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(HERE, "..", "src");

const PATTERNS = [
  { name: "StackInfo", regex: /StackInfo/ },
  { name: ".stack", regex: /\.stack\b/ },
];

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return out;
    throw err;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name === "dist") continue;
      out.push(...(await walk(full)));
    } else if (ent.isFile() && ent.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

async function main() {
  const files = await walk(SRC_ROOT);
  const hits = [];
  for (const file of files) {
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const { name, regex } of PATTERNS) {
        if (regex.test(line)) {
          hits.push({
            file: relative(process.cwd(), file),
            line: i + 1,
            pattern: name,
            excerpt: line.trim().slice(0, 160),
          });
        }
      }
    }
  }

  if (hits.length === 0) {
    process.exit(0);
  }
  for (const h of hits) {
    process.stderr.write(
      `${h.file}:${h.line}: domain leak (${h.pattern}) — the control plane must not read the bundle's stack\n  ${h.excerpt}\n`,
    );
  }
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`lint:no-domain-leak crashed: ${String(err)}\n`);
  process.exit(2);
});
