// Phase 2a contract: MCP servers, per-agent tool selection, memories. Paths, request schemas
// (validated by the server) and the shapes the server returns.
import { z } from "zod";
import { secretValue } from "./api.ts";
import type { Id, SecretMap, Timestamp } from "./domain.ts";

export const mcpPaths = {
  servers: "/api/mcp/servers",
  server: (id: string) => `/api/mcp/servers/${id}`,
  serverRefresh: (id: string) => `/api/mcp/servers/${id}/refresh`,
  /** POST: start an OAuth sign-in (`McpOAuthStartBody` → `McpOAuthStartResponse`); DELETE: disconnect. */
  serverOAuth: (id: string) => `/api/mcp/servers/${id}/oauth`,
  /** POST from the redirect page (`McpOAuthCallbackBody` → `McpOAuthCallbackResponse`). */
  oauthCallback: "/api/mcp/oauth/callback",
  agentTools: (agentId: string) => `/api/agents/${agentId}/tools`,
  memories: "/api/memories",
  memory: (id: string) => `/api/memories/${id}`,
} as const;

/**
 * Where the authorization server sends the browser back: a page of the web app (not an /api
 * route, because the SameSite=Strict session cookie isn't sent on that cross-site navigation;
 * the page posts the result with it). The redirect URI is `<the app's origin>` + this path.
 */
export const MCP_OAUTH_REDIRECT_PATH = "/oauth/mcp/callback";

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
  /** `needs_auth`: an HTTP server that wants an OAuth sign-in (none yet, or it expired/was revoked). */
  state: "unknown" | "connecting" | "connected" | "error" | "disabled" | "needs_auth";
  message: string | null;
  /** Upstream server's own name/version from `initialize`. */
  serverInfo: { name: string; version: string } | null;
  checkedAt: Timestamp | null;
}

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
  /** HTTP servers only (null otherwise): OAuth settings and the connection, never the tokens. */
  oauth: McpOAuthView | null;
  enabled: boolean;
  builtin: boolean;
  tools: McpToolInfo[];
  status: McpServerStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * One OAuth connection per server, shared by every agent. The tokens stay on the server; this is
 * what the UI may know about them.
 */
export interface McpOAuthView {
  /** Pre-registered client (optional; empty = dynamic client registration). */
  clientId: string | null;
  /** Write-only, like other secrets. */
  clientSecret: { hint: string } | null;
  /** Scopes to request instead of the server's own choice (space-separated). */
  scopes: string | null;
  /** Holding tokens (they may still be refreshed or fail on the next use). */
  connected: boolean;
  /** Who signed in, from the ID token or a JWT access token, if the server says. */
  account: string | null;
  grantedScopes: string[];
  /** Access token expiry; refreshed automatically when a refresh token exists. */
  expiresAt: Timestamp | null;
  refreshable: boolean;
  /** The authorization server (its issuer) of the last sign-in or attempt. */
  issuer: string | null;
  /** How the app identifies itself to the authorization server. */
  registration: "preregistered" | "dynamic" | null;
}

/** Server names double as tool prefixes, so they are short slugs without `__`. */
const serverName = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "lowercase letters, digits, single - or _ (e.g. github)");

const mcpServerFields = {
  name: serverName,
  transport: z.enum(["stdio", "http"]),
  command: z.string().trim().min(1).nullable(),
  args: z.array(z.string()),
  env: z.record(z.string().min(1), secretValue),
  cwd: z.string().trim().min(1).nullable(),
  url: z.url().nullable(),
  headers: z.record(z.string().min(1), secretValue),
  /** OAuth overrides for HTTP servers without dynamic client registration; null = none. */
  oauth: z
    .object({
      clientId: z.string().trim().min(1).max(500).nullable(),
      clientSecret: secretValue.nullable(),
      scopes: z.string().trim().min(1).max(1000).nullable(),
    })
    .nullable(),
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
    oauth: mcpServerFields.oauth.default(null),
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

// ---- OAuth sign-in ----------------------------------------------------------------------------

/** A same-app path to land on afterwards: `/…` but not `//…` or `/\…` (no open redirect). */
export const appPath = z
  .string()
  .max(2000)
  .refine(
    (p) => /^\/(?![/\\])/.test(p) && ![...p].some((c) => c.charCodeAt(0) < 0x20),
    "must be a path of this app",
  );

export const McpOAuthStartBody = z.object({
  /** Where the redirect page goes after the sign-in (full-page redirect, e.g. on a phone). */
  returnTo: appPath.default("/settings/mcp"),
  /** Opened in a popup/new tab: the redirect page closes itself instead of navigating. */
  popup: z.boolean().default(false),
});
export type McpOAuthStartBody = z.input<typeof McpOAuthStartBody>;
export interface McpOAuthStartResponse {
  /** Open this in the browser (the authorization server's consent page). */
  authorizationUrl: string;
  /** The redirect URI the app registered/uses (for pre-registering a client). */
  redirectUri: string;
}

/** What the authorization server put in the redirect's query, posted by the redirect page. */
export const McpOAuthCallbackBody = z.object({
  state: z.string().min(1).max(500),
  code: z.string().min(1).max(4000).optional(),
  iss: z.string().max(2000).optional(),
  error: z.string().max(200).optional(),
  errorDescription: z.string().max(2000).optional(),
});
export type McpOAuthCallbackBody = z.input<typeof McpOAuthCallbackBody>;
export interface McpOAuthCallbackResponse {
  serverId: Id;
  serverName: string;
  returnTo: string;
  popup: boolean;
}

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
