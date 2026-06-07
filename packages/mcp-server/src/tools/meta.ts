// pipeline_meta — protocol-discovery handler. Reads providers and
// bundles from the installed_extensions registry; advertises the
// host-neutral flag vocabulary derived from FLAG_TO_PRESET so the
// parser surface and the meta echo can never drift.

import { openDb } from "@loomfsm/kernel";

import { FLAG_TO_PRESET } from "../lib/parse-task-args.js";
import { identifierOf } from "../lib/refusal.js";
import type {
  MetaInput,
  PipelineMetaResponse,
  ToolHandler,
} from "../types.js";
import {
  KERNEL_VERSION,
  PLUGIN_API_VERSION,
  PROTOCOL_VERSION,
} from "../version.js";

const ACTIVE_TRANSPORT = "mcp-server";
const AVAILABLE_TRANSPORTS = [ACTIVE_TRANSPORT];
const SANDBOX_KIND = "passthrough";
// No-API-key fallback that ships with the kernel; once the provider-
// router config layer wires into kernel boot, this switches to the
// router-resolved value.
const ACTIVE_DEFAULT_PROVIDER = "claude-code-shuttle";

interface MetaInputWithProject extends MetaInput {
  project_dir: string;
}

interface ExtRow {
  name: string;
  version: string;
}

export function createMetaTool(): ToolHandler<MetaInputWithProject, PipelineMetaResponse> {
  return async (input) => {
    const db = openDb(input.project_dir);

    const providerRows = db
      .prepare(
        "SELECT name, version FROM installed_extensions " +
          "WHERE kind = 'provider' AND status = 'enabled' " +
          "ORDER BY name",
      )
      .all() as unknown as ExtRow[];

    const bundleRows = db
      .prepare(
        "SELECT name, version FROM installed_extensions " +
          "WHERE kind = 'bundle' AND status = 'enabled' " +
          "ORDER BY name",
      )
      .all() as unknown as ExtRow[];

    const enabled = providerRows.map((r) => r.name);

    return {
      protocol_version: PROTOCOL_VERSION,
      plugin_api_version: PLUGIN_API_VERSION,
      kernel_version: KERNEL_VERSION,
      client_identifier_unverified: identifierOf(input),
      flag_vocabulary: Object.keys(FLAG_TO_PRESET),
      transports: {
        active: ACTIVE_TRANSPORT,
        available: AVAILABLE_TRANSPORTS.slice(),
      },
      providers: {
        enabled,
        active_default: ACTIVE_DEFAULT_PROVIDER,
        compatible_with_client: enabled.slice(),
      },
      bundles_available: bundleRows.map((r) => ({ name: r.name, version: r.version })),
      sandbox: { kind: SANDBOX_KIND },
    };
  };
}

export type { MetaInputWithProject };
