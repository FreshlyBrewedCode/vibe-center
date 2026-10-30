import {
  type AgentToolGroup,
  type AgentToolsPatchBody,
  BUILTIN_SERVER_ID,
  type McpServerInput,
  type McpServerPatchBody,
  type McpServerView,
  type Memory,
  type MemoryBody,
  type MemoryPatchBody,
  type SecretInput,
  type SecretMap,
} from "@vibe-center/shared";
import type { Repos } from "../db/repos/index.ts";
import type { McpServerFields, McpServerRecord } from "../db/repos/mcp-servers.ts";
import { HttpError } from "../domain/errors.ts";
import type { EventBus } from "../events/bus.ts";
import { type BuiltinTool, builtinTools, toolInfo } from "./builtin/index.ts";
import type { BuiltinDeps } from "./builtin/types.ts";
import { ToolCatalog } from "./catalog.ts";
import { McpGateway } from "./gateway.ts";
import { CallRecorder } from "./recorder.ts";
import { UpstreamPool } from "./upstream.ts";

/**
 * Phase 2a in one place: the MCP server registry, per-agent tool selection, memories (for the
 * UI) and the gateway every ACP session talks to.
 */
export class McpService {
  readonly gateway: McpGateway;
  readonly catalog: ToolCatalog;
  private readonly upstreams: UpstreamPool;
  private readonly recorder: CallRecorder;
  private builtins: Map<string, BuiltinTool> | null = null;
  private deps: Omit<BuiltinDeps, "repos" | "bus"> | null = null;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly repos: Repos,
    private readonly bus: EventBus,
  ) {
    this.upstreams = new UpstreamPool({
      status: (id, status) => {
        this.repos.mcpServers.setStatus(id, status);
        this.publish(id);
      },
      tools: (id, tools) => {
        const before = JSON.stringify(this.repos.mcpServers.get(id)?.tools ?? []);
        this.repos.mcpServers.setTools(id, tools);
        this.publish(id);
        if (JSON.stringify(tools) !== before) this.toolsChanged(null);
      },
    });
    this.catalog = new ToolCatalog(repos, () => [...this.builtinMap().values()].map(toolInfo));
    this.recorder = new CallRecorder(repos, bus);
    this.gateway = new McpGateway(
      repos,
      this.catalog,
      () => this.builtinMap(),
      this.upstreams,
      this.recorder,
    );
    this.unsubscribe = bus.subscribe((e) => {
      if (e.type === "agent.deleted") this.gateway.revokeAgent(e.agentId);
    });
  }

  /** The built-in tools need the chat service, which needs the gateway: wired after both exist. */
  bind(deps: Omit<BuiltinDeps, "repos" | "bus">): void {
    this.deps = deps;
  }

  private builtinMap(): Map<string, BuiltinTool> {
    if (!this.builtins) {
      if (!this.deps) throw new Error("McpService.bind() was not called");
      const tools = builtinTools({ repos: this.repos, bus: this.bus, ...this.deps });
      this.builtins = new Map(tools.map((t) => [t.name, t]));
    }
    return this.builtins;
  }

  /** Connect every enabled upstream server in the background (discovers tools, reports health). */
  connectAll(): void {
    for (const s of this.repos.mcpServers.list()) {
      if (s.transport !== "builtin" && s.enabled) this.upstreams.refresh(s).catch(() => {});
    }
  }

  async close(): Promise<void> {
    this.unsubscribe();
    this.recorder.dispose();
    await this.gateway.close();
    await this.upstreams.close();
  }

  // ---- servers ----------------------------------------------------------------------------------

  list(): McpServerView[] {
    return this.repos.mcpServers.list().map((s) => this.view(s));
  }

  get(id: string): McpServerView {
    return this.view(this.require(id));
  }

  create(input: McpServerInput): McpServerView {
    this.checkName(input.name);
    const fields: McpServerFields = {
      ...input,
      ...this.endpointFields(input),
      env: resolveSecrets(input.env, {}),
      headers: resolveSecrets(input.headers, {}),
    };
    const rec = this.repos.mcpServers.insert(fields);
    this.publish(rec.id);
    if (rec.enabled) this.upstreams.refresh(rec).catch(() => {});
    return this.view(rec);
  }

  update(id: string, patch: McpServerPatchBody): McpServerView {
    const cur = this.require(id);
    if (cur.transport === "builtin") throw new HttpError(400, "the built-in server can't be changed");
    if (patch.name !== undefined && patch.name !== cur.name) this.checkName(patch.name);
    const merged = {
      name: patch.name ?? cur.name,
      transport: patch.transport ?? (cur.transport as "stdio" | "http"),
      command: patch.command !== undefined ? patch.command : cur.command,
      args: patch.args ?? cur.args,
      cwd: patch.cwd !== undefined ? patch.cwd : cur.cwd,
      url: patch.url !== undefined ? patch.url : cur.url,
      enabled: patch.enabled ?? cur.enabled,
    };
    const fields: McpServerFields = {
      ...merged,
      ...this.endpointFields(merged),
      env: patch.env ? resolveSecrets(patch.env, cur.env) : cur.env,
      headers: patch.headers ? resolveSecrets(patch.headers, cur.headers) : cur.headers,
    };
    const rec = this.repos.mcpServers.update(id, fields)!;
    void this.upstreams.drop(id).then(() => {
      if (rec.enabled) return this.upstreams.refresh(rec).catch(() => {});
      this.repos.mcpServers.setStatus(id, { ...rec.status, state: "disabled", message: null });
      this.publish(id);
    });
    if (cur.name !== rec.name || cur.enabled !== rec.enabled) this.toolsChanged(null);
    this.publish(id);
    return this.view(rec);
  }

  async delete(id: string): Promise<void> {
    const cur = this.require(id);
    if (cur.transport === "builtin") throw new HttpError(400, "the built-in server can't be removed");
    await this.upstreams.drop(id);
    this.repos.mcpServers.delete(id);
    this.bus.publish({ type: "mcp.server.deleted", serverId: id });
    this.toolsChanged(null);
  }

  /** Reconnect and rediscover tools; resolves with the new state (errors are in its status). */
  async refresh(id: string): Promise<McpServerView> {
    const rec = this.require(id);
    if (rec.transport !== "builtin") {
      if (!rec.enabled) throw new HttpError(400, "enable the server first");
      await this.upstreams.refresh(rec).catch(() => {});
    }
    return this.get(id);
  }

  private view(s: McpServerRecord): McpServerView {
    const builtin = s.transport === "builtin";
    return {
      id: s.id,
      name: s.name,
      transport: s.transport,
      command: s.command,
      args: s.args,
      env: maskSecrets(s.env),
      cwd: s.cwd,
      url: s.url,
      headers: maskSecrets(s.headers),
      enabled: builtin || s.enabled,
      builtin,
      tools: this.catalog.toolsOf(s),
      status: builtin
        ? {
            state: "connected",
            message: null,
            serverInfo: { name: "vibe-center", version: "1.0.0" },
            checkedAt: null,
          }
        : s.enabled
          ? s.status
          : { ...s.status, state: "disabled" },
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }

  private publish(id: string): void {
    const s = this.repos.mcpServers.get(id);
    if (s) this.bus.publish({ type: "mcp.server.upsert", server: this.view(s) });
  }

  private require(id: string): McpServerRecord {
    const s = this.repos.mcpServers.get(id);
    if (!s) throw new HttpError(404, `MCP server not found: ${id}`);
    return s;
  }

  private checkName(name: string): void {
    if (name === BUILTIN_SERVER_ID) throw new HttpError(400, `"${name}" is reserved`);
    if (this.repos.mcpServers.byName(name)) throw new HttpError(409, `an MCP server named "${name}" exists`);
  }

  /** Clear the fields the other transport uses. */
  private endpointFields(f: { transport: "stdio" | "http"; command: string | null; url: string | null }) {
    if (f.transport === "stdio" && !f.command) throw new HttpError(400, "a stdio server needs a command");
    if (f.transport === "http" && !f.url) throw new HttpError(400, "an http server needs a URL");
    return f.transport === "stdio" ? { url: null } : { command: null, args: [], cwd: null };
  }

  // ---- per-agent tools --------------------------------------------------------------------------

  agentTools(agentId: string): AgentToolGroup[] {
    if (!this.repos.agents.get(agentId)) throw new HttpError(404, `agent not found: ${agentId}`);
    return this.catalog.groups(agentId);
  }

  setAgentTool(agentId: string, body: AgentToolsPatchBody): AgentToolGroup[] {
    if (!this.repos.agents.get(agentId)) throw new HttpError(404, `agent not found: ${agentId}`);
    this.require(body.serverId);
    this.repos.db.transaction(() => {
      if (body.tool) {
        this.repos.agentTools.set(agentId, body.serverId, body.tool, body.enabled);
      } else {
        this.repos.agentTools.set(agentId, body.serverId, "*", body.enabled);
        this.repos.agentTools.clearToolOverrides(agentId, body.serverId);
      }
    })();
    this.toolsChanged(agentId);
    return this.catalog.groups(agentId);
  }

  private toolsChanged(agentId: string | null): void {
    this.gateway.toolsChanged(agentId);
    this.bus.publish({ type: "agent.tools.changed", agentId });
  }

  // ---- memories (UI) ----------------------------------------------------------------------------

  memories(q: { scope?: string; q?: string; limit: number }): Memory[] {
    const scope =
      q.scope === "shared"
        ? ({ kind: "shared" } as const)
        : q.scope
          ? ({ kind: "agent", agentId: q.scope } as const)
          : ({ kind: "all" } as const);
    return q.q ? this.repos.memories.search(q.q, scope, q.limit) : this.repos.memories.list(scope, q);
  }

  createMemory(
    body: Required<Pick<MemoryBody, "content">> & { agentId: string | null; tags: string[] },
  ): Memory {
    if (body.agentId && !this.repos.agents.get(body.agentId)) throw new HttpError(400, "unknown agent");
    const m = this.repos.memories.insert(body);
    this.bus.publish({ type: "memory.upsert", memory: m });
    return m;
  }

  updateMemory(id: string, patch: MemoryPatchBody): Memory {
    if (patch.agentId && !this.repos.agents.get(patch.agentId)) throw new HttpError(400, "unknown agent");
    const m = this.repos.memories.update(id, patch);
    if (!m) throw new HttpError(404, "memory not found");
    this.bus.publish({ type: "memory.upsert", memory: m });
    return m;
  }

  deleteMemory(id: string): void {
    if (!this.repos.memories.get(id)) throw new HttpError(404, "memory not found");
    this.repos.memories.delete(id);
    this.bus.publish({ type: "memory.deleted", memoryId: id });
  }
}

/** Last 4 characters of long values only, so short secrets don't leak half their content. */
export function maskSecrets(m: Record<string, string>): SecretMap {
  return Object.fromEntries(
    Object.entries(m).map(([k, v]) => [k, { hint: v.length >= 12 ? v.slice(-4) : "" }]),
  );
}

/** New values replace, `{ keep: true }` keeps the stored value, keys left out are removed. */
export function resolveSecrets(input: SecretInput, stored: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string") out[k] = v;
    else if (k in stored) out[k] = stored[k]!;
    else throw new HttpError(400, `no stored value to keep for ${k}`);
  }
  return out;
}
