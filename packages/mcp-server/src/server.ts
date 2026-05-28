// Stdio MCP server factory. Wires the three read-only tool handlers
// into the SDK's request-dispatch surface and surfaces them as a
// direct-callable map so tests skip the JSON-RPC framing and exercise
// the handler bodies in-process.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createExtensionsListTool } from "./tools/extensions-list.js";
import { createMetaTool, type MetaInputWithProject } from "./tools/meta.js";
import { createStateGetTool } from "./tools/state-get.js";
import type {
  ExtensionsListInput,
  ExtensionsListResponse,
  PipelineMetaResponse,
  PipelineStateView,
  StateGetInput,
  ToolHandler,
} from "./types.js";

const SERVER_NAME = "@loom/mcp-server";
const SERVER_VERSION = "0.0.0";

export interface ToolRegistry {
  pipeline_meta: ToolHandler<MetaInputWithProject, PipelineMetaResponse>;
  pipeline_state_get: ToolHandler<StateGetInput, PipelineStateView>;
  pipeline_extensions_list: ToolHandler<ExtensionsListInput, ExtensionsListResponse>;
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
];

export function createServer(): CreateServerHandle {
  const tools: ToolRegistry = {
    pipeline_meta: createMetaTool(),
    pipeline_state_get: createStateGetTool(),
    pipeline_extensions_list: createExtensionsListTool(),
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
