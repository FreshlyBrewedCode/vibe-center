// Events owned by phase 2a (MCP gateway + built-in tools). Gateway tool calls show up as
// `message.upsert` of the harness's tool_call message (its `data.gateway`), not here.
import type { McpServerView, Memory } from "../api-mcp.ts";

export type McpEvent =
  /** A server was added or changed: config, status (connecting/connected/error), discovered tools. */
  | { type: "mcp.server.upsert"; server: McpServerView }
  | { type: "mcp.server.deleted"; serverId: string }
  /** An agent's tool selection changed (or a server's tools did): refetch its tool groups. */
  | { type: "agent.tools.changed"; agentId: string | null }
  | { type: "memory.upsert"; memory: Memory }
  | { type: "memory.deleted"; memoryId: string };
