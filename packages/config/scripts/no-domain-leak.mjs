// Config domain-leak gate.
//
// `@loomfsm/config` is the control layer for EVERY bundle. It binds a roster to
// models, but the roster — agent names, tier names, bundle name — is DATA passed
// in by the caller; the leaf must hardcode none of it. If config ever named a
// specific bundle's agent (`classifier`, `researcher`, …) or a code-domain
// concept (`stack`, `tests_mode`, `tdd`), a second bundle would resolve
// differently from the first and the genericity claim would be hollow.
//
// Backend / provider / family names (`claude-code`, `anthropic`, `openrouter`,
// …) are INFRA, not a bundle's domain — they are allowed (the capability table
// needs them), so this gate does NOT forbid them. It forbids only bundle-DOMAIN
// tokens, mirroring the driver / daemon / server `StackInfo|.stack` gates.
//
// Run on `packages/config/src` (NOT test — fixtures legitimately use a second
// bundle's roster names to prove genericity):
//   node scripts/no-domain-leak.mjs   →  must be empty

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(HERE, "..", "src");

const PATTERNS = [
  // code-bundle agent names
  { name: "agent:classifier", regex: /\bclassifier\b/ },
  { name: "agent:implementer", regex: /\bimplementer\b/ },
  { name: "agent:architect", regex: /\barchitect\b/ },
  { name: "agent:adjudicator", regex: /\badjudicator\b/ },
  { name: "agent:challenger", regex: /\bchallenger\b/ },
  { name: "agent:*-reviewer", regex: /-reviewer\b/ },
  // spec-bundle agent names
  { name: "agent:researcher", regex: /\bresearcher\b/ },
  { name: "agent:spec-writer", regex: /\bspec-writer\b/ },
  // code-domain concepts
  { name: "concept:stack", regex: /StackInfo|\.stack\b/ },
  { name: "concept:tests_mode", regex: /\btests_mode\b/ },
  { name: "concept:tdd", regex: /\btdd\b/ },
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
      `${h.file}:${h.line}: domain leak (${h.pattern}) — @loomfsm/config must name no bundle's domain; the roster is data passed in\n  ${h.excerpt}\n`,
    );
  }
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`lint:no-domain-leak crashed: ${String(err)}\n`);
  process.exit(2);
});
