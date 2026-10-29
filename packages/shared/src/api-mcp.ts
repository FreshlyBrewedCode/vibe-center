// Phase 2a contract: MCP servers, per-agent tool selection, memories. Paths, request schemas
// (validated by the server) and the shapes the server returns.
import { z } from "zod";
import type { Id, Timestamp } from "./domain.ts";

export const mcpPaths = {
  servers: "/api/mcp/servers",
  server: (id: string) => `/api/mcp/servers/${id}`,
  serverRefresh: (id: string) => `/api/mcp/servers/${id}/refresh`,
  agentTools: (agentId: string) => `/api/agents/${agentId}/tools`,
  memories: "/api/memories",
  memory: (id: string) => `/api/memories/${id}`,
} as const;

/** Id of the app's own MCP server (memory, conversation search, agents). */
export const BUILTIN_SERVER_ID = "builtin";

// ---- MCP servers ------------------------------------------------------------------------------

export type McpTransport = "stdio" | "http" | "builtin";

export interface McpToolInfo {
  name: string;
  description: string;
  /** JSON Schema of the tool's arguments. */
  inputSchema: unknown;
}

export interface McpServerStatus {
  state: "unknown" | "connecting" | "connected" | "error" | "disabled";
  message: string | null;
  /** Upstream server's own name/version from `initialize`. */
  serverInfo: { name: string; version: string } | null;
  checkedAt: Timestamp | null;
}

/**
 * A secret-bearing map (env vars, HTTP headers) as the client sees it: keys and a hint, never the
 * value. `hint` is the last 4 characters for values of 12+ characters, else empty.
 */
export type SecretMap = Record<string, { hint: string }>;

export interface McpServerView {
  id: Id;
  /** Also the tool prefix: tools appear to agents as `<name>__<tool>`. */
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  env: SecretMap;
  cwd: string | null;
  url: string | null;
  headers: SecretMap;
  enabled: boolean;
  builtin: boolean;
  tools: McpToolInfo[];
  status: McpServerStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Server names double as tool prefixes, so they are short slugs without `__`. */
const serverName = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "lowercase letters, digits, single - or _ (e.g. github)");

/** New value, or `{ keep: true }` to keep the stored secret. Keys left out are removed. */
const secretValue = z.union([z.string(), z.object({ keep: z.literal(true) })]);
export type SecretInput = Record<string, z.infer<typeof secretValue>>;

const mcpServerFields = {
  name: serverName,
  transport: z.enum(["stdio", "http"]),
  command: z.string().trim().min(1).nullable(),
  args: z.array(z.string()),
  env: z.record(z.string().min(1), secretValue),
  cwd: z.string().trim().min(1).nullable(),
  url: z.url().nullable(),
  headers: z.record(z.string().min(1), secretValue),
  enabled: z.boolean(),
};

export const McpServerBody = z
  .object({
    ...mcpServerFields,
    command: mcpServerFields.command.default(null),
    args: mcpServerFields.args.default([]),
    env: mcpServerFields.env.default({}),
    cwd: mcpServerFields.cwd.default(null),
    url: mcpServerFields.url.default(null),
    headers: mcpServerFields.headers.default({}),
    enabled: mcpServerFields.enabled.default(true),
  })
  .refine((b) => (b.transport === "stdio" ? !!b.command : !!b.url), {
    message: "stdio servers need a command, http servers a URL",
  });
export type McpServerBody = z.input<typeof McpServerBody>;
export type McpServerInput = z.output<typeof McpServerBody>;
export const McpServerPatchBody = z.object(mcpServerFields).partial();
export type McpServerPatchBody = z.input<typeof McpServerPatchBody>;

export type McpServersResponse = McpServerView[];

// ---- per-agent tool selection -----------------------------------------------------------------

/**
 * One server's tools for one agent. Resolution: a per-tool override if set, else the server
 * toggle, else the default (built-in: on, other servers: off until enabled for the agent).
 * Tools a server adds later follow the server toggle.
 */
export interface AgentToolGroup {
  serverId: Id;
  serverName: string;
  builtin: boolean;
  /** The server is disabled globally or failing; its tools are offered only when it works. */
  serverEnabled: boolean;
  status: McpServerStatus;
  /** The server toggle for this agent. */
  enabled: boolean;
  tools: (McpToolInfo & { enabled: boolean; overridden: boolean; exposedName: string })[];
}
export type AgentToolsResponse = AgentToolGroup[];

/** Toggle a whole server (`tool` omitted: clears per-tool overrides) or one tool. */
export const AgentToolsPatchBody = z.object({
  serverId: z.string().min(1),
  tool: z.string().min(1).optional(),
  enabled: z.boolean(),
});
export type AgentToolsPatchBody = z.input<typeof AgentToolsPatchBody>;

// ---- memories ---------------------------------------------------------------------------------

export interface Memory {
  id: Id;
  /** null = shared between all agents. */
  agentId: Id | null;
  content: string;
  tags: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export const MemoriesQuery = z.object({
  /** An agent id, `shared`, or omitted for all. */
  scope: z.string().optional(),
  q: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export const MemoryBody = z.object({
  agentId: z.string().min(1).nullable().default(null),
  content: z.string().trim().min(1).max(10_000),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});
export type MemoryBody = z.input<typeof MemoryBody>;
export const MemoryPatchBody = z
  .object({
    content: z.string().trim().min(1).max(10_000),
    tags: z.array(z.string().trim().min(1).max(40)).max(20),
    agentId: z.string().min(1).nullable(),
  })
  .partial();
export type MemoryPatchBody = z.input<typeof MemoryPatchBody>;
export type MemoriesResponse = Memory[];
