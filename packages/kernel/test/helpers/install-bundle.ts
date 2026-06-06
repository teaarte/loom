// Plant an enabled `installed_extensions` row for a bundle directly — the
// minimal fixture the kernel tick path needs (initializeTask's
// NO_ENABLED_BUNDLE check reads this table to resolve the active bundle).
//
// The reconcile machinery that normally writes this row is BUILD-TIME and
// lives in `@loomfsm/loader`. The kernel test suite stays loader-free on
// purpose — that is exactly the boundary the tick-vs-build split asserts: the
// substrate needs no build-time assembly to tick or replay. So these tests
// insert the row themselves rather than reaching for the loader.

import { openDb } from "../../src/state.js";
import type { NowToken } from "../../src/types/now.js";

export function installBundleRow(projectDir: string, name: string, now: NowToken): void {
  const db = openDb(projectDir);
  const id = `bundle:${name}`;
  const manifest = JSON.stringify({
    manifest_version: "1.0",
    name,
    kind: "bundle",
    publisher: "@loom",
    version: "1.0.0",
    requires: { kernel_api: "^3.0.0" },
  });
  db.prepare(
    "INSERT INTO installed_extensions " +
      "(id, kind, name, publisher, version, manifest_json, status, installed_at, updated_at, failure_reason) " +
      "VALUES (?, 'bundle', ?, '@loom', '1.0.0', ?, 'enabled', ?, ?, NULL)",
  ).run(id, name, manifest, now, now);
}
