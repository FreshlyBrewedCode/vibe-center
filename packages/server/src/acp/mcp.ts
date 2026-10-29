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
  /** What the harness advertised in `initialize` (e.g. whether it can do HTTP MCP servers). */
  capabilities?: acp.AgentCapabilities;
}

/**
 * What the runtime asks for every ACP session it creates or resumes. The app's implementation is
 * the MCP gateway (`mcp/gateway.ts`): one HTTP server `vibe` with a per-session credential, or a
 * stdio bridge to it for harnesses without HTTP MCP. `noMcp` is for tests and probes.
 */
export interface McpProvider {
  forSession(ctx: McpSessionContext): Promise<McpSetup>;
}

export const noMcp: McpProvider = {
  forSession: async () => ({ servers: [], allowedTools: [] }),
};
