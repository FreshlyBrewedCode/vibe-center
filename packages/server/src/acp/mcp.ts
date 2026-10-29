import type * as acp from "./protocol.ts";

/** What a session gets from the app's MCP side. */
export interface McpSetup {
  /** Passed as `mcpServers` in session/new, session/resume and session/load. */
  servers: acp.McpServer[];
  /**
   * Tool patterns the harness may call without a permission round trip (Claude Code
   * `allowedTools`, e.g. `mcp__vibe`). Harnesses without such a knob ignore it.
   */
  allowedTools: string[];
}

export interface McpSessionContext {
  agentId: string;
  /** The app's id for the session (DB `sessions.id`), stable across harness restarts. */
  sessionKey: string;
}

/**
 * SEAM for phase 2a. The runtime asks this for every ACP session it creates or resumes.
 * TODO(phase 2a): implement a provider that mints a per-session credential and returns the
 * app's MCP gateway as one HTTP server, e.g.
 *   { servers: [{ type: "http", name: "vibe", url: `${base}/mcp`, headers: [{ name: "Authorization",
 *     value: `Bearer ${credential}` }] }], allowedTools: ["mcp__vibe"] }
 * and pass it to createServer({ mcp }) (see server.ts).
 */
export interface McpProvider {
  forSession(ctx: McpSessionContext): Promise<McpSetup>;
}

export const noMcp: McpProvider = {
  forSession: async () => ({ servers: [], allowedTools: [] }),
};
