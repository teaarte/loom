// Stdio MCP server factory. Wires the three read-only tool handlers
// into the SDK's request-dispatch surface and surfaces them as a
// direct-callable map so tests skip the JSON-RPC framing and exercise
// the handler bodies in-process.

import type { Registry } from "@loom/kernel";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createBackupTool } from "./tools/backup.js";
import { createContinueTaskTool } from "./tools/continue-task.js";
import { createExtensionsListTool } from "./tools/extensions-list.js";
import { createIssueCrossOwnerMarkerTool } from "./tools/issue-marker.js";
import { createMetaTool, type MetaInputWithProject } from "./tools/meta.js";
import { createRecoverTool } from "./tools/recover.js";
import { createRestoreTool } from "./tools/restore.js";
import { createRunTaskTool } from "./tools/run-task.js";
import { createStateGetTool } from "./tools/state-get.js";
import type {
  BackupInput,
  BackupResponse,
  ContinueTaskRequestInput,
  ContinueTaskResponse,
  ExtensionsListInput,
  ExtensionsListResponse,
  IssueCrossOwnerMarkerInput,
  IssueCrossOwnerMarkerResponse,
  PipelineMetaResponse,
  PipelineStateView,
  RecoverTaskInput,
  RecoverTaskResponse,
  RestoreInput,
  RestoreResponse,
  RunTaskInput,
  RunTaskResponse,
  StateGetInput,
  ToolHandler,
} from "./types.js";

// Dependencies the active-task tools need but the read-only surface does
// not. `resolveRegistry` assembles the FSM registry for a project (the
// production wiring that imports the active bundle lands separately);
// `allowlistPath` overrides the project-dir allowlist file (tests point
// at a tmpfile). Omitted → the mutating tools refuse the active-task
// path with a structured error envelope.
export interface ServerDeps {
  resolveRegistry?: (projectDir: string) => Promise<Registry> | Registry;
  allowlistPath?: string;
}

const SERVER_NAME = "@loom/mcp-server";
const SERVER_VERSION = "0.0.0";

export interface ToolRegistry {
  pipeline_meta: ToolHandler<MetaInputWithProject, PipelineMetaResponse>;
  pipeline_state_get: ToolHandler<StateGetInput, PipelineStateView>;
  pipeline_extensions_list: ToolHandler<ExtensionsListInput, ExtensionsListResponse>;
  pipeline_run_task: ToolHandler<RunTaskInput, RunTaskResponse>;
  pipeline_continue_task: ToolHandler<ContinueTaskRequestInput, ContinueTaskResponse>;
  pipeline_recover: ToolHandler<RecoverTaskInput, RecoverTaskResponse>;
  pipeline_issue_cross_owner_marker: ToolHandler<
    IssueCrossOwnerMarkerInput,
    IssueCrossOwnerMarkerResponse
  >;
  pipeline_backup: ToolHandler<BackupInput, BackupResponse>;
  pipeline_restore: ToolHandler<RestoreInput, RestoreResponse>;
}

export interface CreateServerHandle {
  server: Server;
  tools: ToolRegistry;
}

// Tool descriptors surfaced on `tools/list`. Schemas stay coarse for
// these read-only handlers; richer per-property typing belongs with
// the mutating-tool surface whose required-field matrices justify a
// shared schema package.
const TOOL_DESCRIPTORS = [
  {
    name: "pipeline_meta",
    description:
      "Returns protocol / plugin / kernel versions, transport surface, " +
      "installed providers and bundles, and the flag vocabulary the " +
      "server-side parser currently honors.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_dir: { type: "string" },
        client_identifier_unverified: { type: "string" },
        client_capabilities: { type: "object" },
      },
      required: ["project_dir"],
    },
  },
  {
    name: "pipeline_state_get",
    description:
      "Inspects pipeline state. Four output formats: a compact summary " +
      "(default), the full PipelineState aggregate, per-table JSONL, " +
      "or a stable-width ASCII rendering.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_dir: { type: "string" },
        format: { type: "string", enum: ["summary", "json", "jsonl", "pretty-table"] },
        table: { type: "string" },
        since: { type: "string" },
        limit: { type: "number" },
      },
      required: ["project_dir"],
    },
  },
  {
    name: "pipeline_extensions_list",
    description:
      "Lists installed extensions (bundles, providers, mcp-clients) " +
      "from the project registry. Filters by kind / status; " +
      "include_manifest pulls the full manifest snapshot into each entry.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_dir: { type: "string" },
        kind: { type: "string", enum: ["bundle", "provider", "mcp-client"] },
        status: { type: "string", enum: ["enabled", "disabled", "failed"] },
        include_manifest: { type: "boolean" },
      },
      required: ["project_dir"],
    },
  },
  {
    name: "pipeline_run_task",
    description:
      "Initializes a new task and returns the first directive shaped as a " +
      "wire response (spawn-agent | spawn-agents-parallel | ask-user | " +
      "complete | error). client_idempotency_uuid is required; a replay " +
      "with the same value returns the cached creation response.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_dir: { type: "string" },
        task: { type: "string" },
        client_idempotency_uuid: { type: "string" },
        policy_preset: { type: "string" },
        gate_policies: { type: "object" },
        complexity_hint: { type: "string", enum: ["simple", "medium", "complex"] },
        tests_mode_hint: { type: "string", enum: ["tdd", "regression-only"] },
        stack: { type: "object" },
        owner_id: { type: "string" },
        client_identifier_unverified: { type: "string" },
      },
      required: ["project_dir", "task", "client_idempotency_uuid"],
    },
  },
  {
    name: "pipeline_continue_task",
    description:
      "Delivers an agent result, a fanout batch, or a user answer and " +
      "returns the next directive shaped as a wire response. Idempotent " +
      "by agent_run_id / gate_event_id — a duplicate delivery returns the " +
      "cached next-step response.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_dir: { type: "string" },
        driver_state_id: { type: "string" },
        input: { type: "object" },
        client_identifier_unverified: { type: "string" },
      },
      required: ["project_dir", "driver_state_id", "input"],
    },
  },
  {
    name: "pipeline_recover",
    description:
      "Recovers a stuck task. Five choices: abandon | force-close | retry | " +
      "retry-failed | cancel-pending. recovery_id is server-issued — omit it " +
      "on the first call (the kernel mints one and returns it), pass it back " +
      "to replay the cached response, or omit it to issue a new recovery " +
      "action. agent_run_ids is required for retry-failed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_dir: { type: "string" },
        driver_state_id: { type: "string" },
        choice: {
          type: "string",
          enum: ["abandon", "force-close", "retry", "retry-failed", "cancel-pending"],
        },
        agent_run_ids: { type: "array", items: { type: "string" } },
        recovery_id: { type: "string" },
        owner_id: { type: "string" },
        marker: { type: "object" },
        client_identifier_unverified: { type: "string" },
      },
      required: ["project_dir", "driver_state_id", "choice"],
    },
  },
  {
    name: "pipeline_issue_cross_owner_marker",
    description:
      "Mints a single-use, TTL-bounded cross-owner bypass marker for a " +
      "task whose owner differs from the caller. Possessing the bypass-HMAC " +
      "key (env var or user-global key file) is the authorization to mint; " +
      "returns the signed marker fields to pass to pipeline_recover.marker. " +
      "Refuses with BYPASS_KEY_MISSING when no key is configured.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_dir: { type: "string" },
        driver_state_id: { type: "string" },
        ttl_ms: { type: "number" },
        client_identifier_unverified: { type: "string" },
      },
      required: ["project_dir", "driver_state_id", "ttl_ms"],
    },
  },
  {
    name: "pipeline_backup",
    description:
      "Writes a consistent textual SQL snapshot of the project state to " +
      "`to` (a relative path resolves against project_dir). Returns " +
      "bytes_written, the threaded timestamp, and the resolved backup_path.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_dir: { type: "string" },
        to: { type: "string" },
        client_identifier_unverified: { type: "string" },
      },
      required: ["project_dir", "to"],
    },
  },
  {
    name: "pipeline_restore",
    description:
      "Restores project state from a backup. A .sql dump is parsed through a " +
      "statement allowlist (out-of-allowlist statements surface " +
      "RESTORE_REJECTED); a binary .db is an operator-explicit file swap. " +
      "Refuses without confirm:true.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project_dir: { type: "string" },
        from: { type: "string" },
        format: { type: "string", enum: ["sql", "binary"] },
        confirm: { type: "boolean" },
        client_identifier_unverified: { type: "string" },
      },
      required: ["project_dir", "from", "format"],
    },
  },
];

export function createServer(deps: ServerDeps = {}): CreateServerHandle {
  const tools: ToolRegistry = {
    pipeline_meta: createMetaTool(),
    pipeline_state_get: createStateGetTool(),
    pipeline_extensions_list: createExtensionsListTool(),
    pipeline_run_task: createRunTaskTool(deps),
    pipeline_continue_task: createContinueTaskTool(deps),
    pipeline_recover: createRecoverTool(deps),
    pipeline_issue_cross_owner_marker: createIssueCrossOwnerMarkerTool(deps),
    pipeline_backup: createBackupTool(deps),
    pipeline_restore: createRestoreTool(deps),
  };

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DESCRIPTORS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    const result = await dispatch(tools, name, args);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  });

  return { server, tools };
}

async function dispatch(
  tools: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (name === "pipeline_meta") {
    return await tools.pipeline_meta(args as unknown as MetaInputWithProject);
  }
  if (name === "pipeline_state_get") {
    return await tools.pipeline_state_get(args as unknown as StateGetInput);
  }
  if (name === "pipeline_extensions_list") {
    return await tools.pipeline_extensions_list(args as unknown as ExtensionsListInput);
  }
  if (name === "pipeline_run_task") {
    return await tools.pipeline_run_task(args as unknown as RunTaskInput);
  }
  if (name === "pipeline_continue_task") {
    return await tools.pipeline_continue_task(args as unknown as ContinueTaskRequestInput);
  }
  if (name === "pipeline_recover") {
    return await tools.pipeline_recover(args as unknown as RecoverTaskInput);
  }
  if (name === "pipeline_issue_cross_owner_marker") {
    return await tools.pipeline_issue_cross_owner_marker(
      args as unknown as IssueCrossOwnerMarkerInput,
    );
  }
  if (name === "pipeline_backup") {
    return await tools.pipeline_backup(args as unknown as BackupInput);
  }
  if (name === "pipeline_restore") {
    return await tools.pipeline_restore(args as unknown as RestoreInput);
  }
  throw new Error(`unknown tool: ${name}`);
}

// Stdio entry. The module never connects automatically — the binary
// entrypoint (a separate file once the CLI session lands) is the only
// caller. Tests construct `createServer()` and exercise the `tools`
// map directly, never reaching this function.
export async function runStdioServer(): Promise<void> {
  const handle = createServer();
  const transport = new StdioServerTransport();
  await handle.server.connect(transport);
}
