import { type AgentToolGroup, BUILTIN_SERVER_ID, type McpToolInfo } from "@vibe-center/shared";
import type { Repos } from "../db/repos/index.ts";
import type { McpServerRecord } from "../db/repos/mcp-servers.ts";

/** One tool as an agent's gateway session offers it. */
export interface ExposedTool {
  /** Name the harness sees: built-ins as is, upstream tools as `<server>__<tool>`. */
  exposedName: string;
  server: McpServerRecord;
  tool: McpToolInfo;
}

/**
 * Claude's tool names are limited to 64 characters and Claude Code prefixes `mcp__vibe__` (11),
 * so longer names are shortened with a hash suffix to stay unique.
 */
const MAX_EXPOSED = 53;

export function exposedName(server: McpServerRecord, tool: string): string {
  const name = server.id === BUILTIN_SERVER_ID ? tool : `${server.name}__${tool}`;
  const clean = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (clean.length <= MAX_EXPOSED) return clean;
  const hash = new Bun.CryptoHasher("sha256").update(name).digest("hex").slice(0, 6);
  return `${clean.slice(0, MAX_EXPOSED - 7)}_${hash}`;
}

/**
 * Which tools an agent gets. Per server: a per-tool override if set, else the agent's server
 * toggle, else the default: built-in tools on, other servers off until enabled for the agent.
 * Tools a server adds later follow the server toggle. Globally disabled servers offer nothing.
 */
export class ToolCatalog {
  constructor(
    private readonly repos: Repos,
    private readonly builtinTools: () => McpToolInfo[],
  ) {}

  toolsOf(server: McpServerRecord): McpToolInfo[] {
    return server.id === BUILTIN_SERVER_ID ? this.builtinTools() : server.tools;
  }

  groups(agentId: string): AgentToolGroup[] {
    const prefs = this.repos.agentTools.forAgent(agentId);
    return this.repos.mcpServers.list().map((server) => {
      const builtin = server.id === BUILTIN_SERVER_ID;
      const p = prefs.get(server.id);
      const serverOn = p?.get("*") ?? builtin;
      return {
        serverId: server.id,
        serverName: server.name,
        builtin,
        serverEnabled: builtin || server.enabled,
        status: builtin
          ? { state: "connected", message: null, serverInfo: null, checkedAt: null }
          : server.enabled
            ? server.status
            : { ...server.status, state: "disabled" },
        enabled: serverOn,
        tools: this.toolsOf(server).map((t) => ({
          ...t,
          enabled: p?.get(t.name) ?? serverOn,
          overridden: p?.has(t.name) ?? false,
          exposedName: exposedName(server, t.name),
        })),
      };
    });
  }

  /** Exactly the tools the agent's gateway session offers right now. */
  enabled(agentId: string): ExposedTool[] {
    const servers = new Map(this.repos.mcpServers.list().map((s) => [s.id, s]));
    const out: ExposedTool[] = [];
    for (const g of this.groups(agentId)) {
      const server = servers.get(g.serverId);
      if (!server || !g.serverEnabled) continue;
      for (const t of g.tools) {
        if (!t.enabled) continue;
        out.push({
          exposedName: t.exposedName,
          server,
          tool: { name: t.name, description: t.description, inputSchema: t.inputSchema },
        });
      }
    }
    return out;
  }
}
