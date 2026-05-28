// `readInstalledManifest` — first rung of the bundle-loader cascade.
//
// Reads the `installed_extensions` row for the bundle and refuses if
// the prior reconciliation pass has not seen this bundle (or has seen
// it but transitioned the status away from enabled). The row's
// `manifest_json` blob is the snapshot the loader cross-checks the
// runtime Bundle structure against — see the
// `manifest-cross-check` validator for the second half of that
// contract.

import { KernelError, openDb } from "../state/db.js";
import type { ExtensionManifest } from "../types/extension.js";

interface InstalledRow {
  manifest_json: string;
  status: string;
}

export function readInstalledManifest(
  project_dir: string,
  bundle_name: string,
): ExtensionManifest {
  const id = `bundle:${bundle_name}`;
  const db = openDb(project_dir);
  const row = db
    .prepare("SELECT manifest_json, status FROM installed_extensions WHERE id = ?")
    .get(id) as InstalledRow | undefined;

  if (row === undefined) {
    throw new KernelError({
      code: "BUNDLE_NOT_INSTALLED",
      message: `bundle '${bundle_name}' has no installed_extensions row; run discoverExtensions first`,
      detail: { expected_id: id, actual_status: null },
    });
  }
  if (row.status !== "enabled") {
    throw new KernelError({
      code: "BUNDLE_NOT_INSTALLED",
      message: `bundle '${bundle_name}' is installed but status='${row.status}'`,
      detail: { expected_id: id, actual_status: row.status },
    });
  }
  // The reconciliation layer enforces shape validation before writing,
  // so the parse is trusted to land an ExtensionManifest.
  return JSON.parse(row.manifest_json) as ExtensionManifest;
}
