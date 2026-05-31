// pipeline_extensions_list — read-only inspection of the
// installed_extensions registry. Filters narrow the result set via
// SQL WHERE clauses; `include_manifest` toggles whether the canonical
// manifest_json column is parsed back into a typed manifest object.

import { openDb } from "@loomfsm/kernel";

import type {
  ExtensionsListEntry,
  ExtensionsListInput,
  ExtensionsListResponse,
  ToolHandler,
} from "../types.js";
import type { ExtensionKind, ExtensionManifest } from "@loomfsm/kernel";

interface ExtensionRow {
  id: string;
  kind: string;
  name: string;
  publisher: string;
  version: string;
  status: string;
  installed_at: string;
  updated_at: string;
  failure_reason: string | null;
  manifest_json: string;
}

export function createExtensionsListTool(): ToolHandler<
  ExtensionsListInput,
  ExtensionsListResponse
> {
  return async (input) => {
    const db = openDb(input.project_dir);

    const wheres: string[] = [];
    const params: (string | number)[] = [];
    if (input.kind !== undefined) {
      wheres.push("kind = ?");
      params.push(input.kind);
    }
    if (input.status !== undefined) {
      wheres.push("status = ?");
      params.push(input.status);
    }
    const whereClause = wheres.length > 0 ? ` WHERE ${wheres.join(" AND ")}` : "";

    const rows = db
      .prepare(
        "SELECT id, kind, name, publisher, version, status, installed_at, updated_at, failure_reason, manifest_json " +
          "FROM installed_extensions" +
          whereClause +
          " ORDER BY id",
      )
      .all(...params) as unknown as ExtensionRow[];

    const include = input.include_manifest === true;

    const extensions: ExtensionsListEntry[] = rows.map((r) => {
      const entry: ExtensionsListEntry = {
        id: r.id,
        kind: r.kind as ExtensionKind,
        name: r.name,
        publisher: r.publisher,
        version: r.version,
        status: r.status as ExtensionsListEntry["status"],
        installed_at: r.installed_at,
        updated_at: r.updated_at,
      };
      if (r.failure_reason !== null) {
        entry.failure_reason = r.failure_reason;
      }
      if (include) {
        entry.manifest = JSON.parse(r.manifest_json) as ExtensionManifest;
      }
      return entry;
    });

    return { extensions };
  };
}
