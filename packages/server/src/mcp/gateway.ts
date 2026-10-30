import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { BUILTIN_SERVER_ID } from "@vibe-center/shared";
import { z } from "zod";
import type { McpProvider, McpSessionContext, McpSetup } from "../acp/mcp.ts";
import type { Repos } from "../db/repos/index.ts";
import {
  type BuiltinTool,
  GATEWAY_INSTRUCTIONS,
  type ToolContext,
  ToolError,
  type ToolResult,
} from "./builtin/index.ts";
import type { ExposedTool, ToolCatalog } from "./catalog.ts";
import type { CallRecorder } from "./recorder.ts";
import { errorText, type UpstreamPool } from "./upstream.ts";

/** Name of the gateway in every session: Claude Code shows its tools as `mcp__vibe__<tool>`. */
export const GATEWAY_NAME = "vibe";
export const GATEWAY_PATH = "/mcp";
/** For harnesses without HTTP MCP: a stdio script that forwards to the HTTP endpoint. */
export const BRIDGE_SCRIPT = join(import.meta.dir, "bridge.ts");

interface Credential {
  agentId: string;
  sessionKey: string;
}

interface GatewaySession {
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
  credential: Credential;
}

const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

/**
 * The app's MCP endpoint. Every ACP session gets one credential (minted in `forSession`) that
 * names its agent and app session; the endpoint offers exactly that agent's enabled tools
 * (built-ins plus upstream servers), proxies upstream calls, and logs every call.
 *
 * Streamable HTTP, stateful: one MCP session per harness connection, so a change to the agent's
 * tools can be pushed as `notifications/tools/list_changed`. Calls are checked against the
 * agent's current selection every time, so a disabled tool stops working at once.
 * Credentials live in memory only: harness processes don't outlive the server.
 */
export class McpGateway implements McpProvider {
  /** sha256(token) → credential. One live credential per agent (it has one ACP session). */
  private credentials = new Map<string, Credential>();
  private sessions = new Map<string, GatewaySession>();
  private baseUrl: string | null = null;

  constructor(
    private readonly repos: Repos,
    private readonly catalog: ToolCatalog,
    private readonly builtins: () => Map<string, BuiltinTool>,
    private readonly upstreams: UpstreamPool,
    private readonly recorder: CallRecorder,
  ) {}

  /** Where harnesses reach the endpoint, e.g. http://127.0.0.1:7880 (set once the server listens). */
  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/$/, "");
  }

  // ---- McpProvider ------------------------------------------------------------------------------

  async forSession(ctx: McpSessionContext): Promise<McpSetup> {
    if (!this.baseUrl) return { servers: [], allowedTools: [] };
    const token = this.mint({ agentId: ctx.agentId, sessionKey: ctx.sessionKey });
    const url = `${this.baseUrl}${GATEWAY_PATH}`;
    // Pre-allow every gateway tool in Claude Code (`mcp__vibe` matches all of them): the gateway
    // already enforces the agent's selection.
    const allowedTools = [`mcp__${GATEWAY_NAME}`];
    if (ctx.capabilities && !ctx.capabilities.mcpCapabilities?.http) {
      return {
        servers: [
          {
            name: GATEWAY_NAME,
            command: process.execPath,
            args: [BRIDGE_SCRIPT],
            env: [
              { name: "VIBE_MCP_URL", value: url },
              { name: "VIBE_MCP_TOKEN", value: token },
            ],
          },
        ],
        allowedTools,
      };
    }
    return {
      servers: [
        {
          type: "http",
          name: GATEWAY_NAME,
          url,
          headers: [{ name: "Authorization", value: `Bearer ${token}` }],
        },
      ],
      allowedTools,
      credential: { server: GATEWAY_NAME, token },
    };
  }

  private mint(cred: Credential): string {
    this.revokeAgent(cred.agentId);
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    this.credentials.set(sha256(token), cred);
    return token;
  }

  /** Invalidate an agent's credential and close its MCP sessions (agent deleted, new session). */
  revokeAgent(agentId: string): void {
    for (const [hash, c] of this.credentials) {
      if (c.agentId === agentId) this.credentials.delete(hash);
    }
    for (const [id, s] of this.sessions) {
      if (s.credential.agentId === agentId) {
        this.sessions.delete(id);
        void s.server.close().catch(() => {});
      }
    }
  }

  /** The agent's tool selection changed: tell its live sessions to list tools again. */
  toolsChanged(agentId: string | null): void {
    for (const s of this.sessions.values()) {
      if (agentId === null || s.credential.agentId === agentId) {
        void s.server.sendToolListChanged().catch(() => {});
      }
    }
  }

  async close(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    this.credentials.clear();
    await Promise.all(all.map((s) => s.server.close().catch(() => {})));
  }

  // ---- HTTP -------------------------------------------------------------------------------------

  async handle(req: Request): Promise<Response> {
    // Harnesses run on this machine and talk to 127.0.0.1 directly. Anything that came through
    // `tailscale serve` or from a browser is refused, whatever credential it has.
    if (req.headers.has("x-forwarded-for") || req.headers.has("origin")) {
      return rpcError(403, "the MCP gateway is only reachable from this machine");
    }
    const auth = req.headers.get("authorization") ?? "";
    const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
    const credential = token ? this.credentials.get(sha256(token)) : undefined;
    if (!credential) return rpcError(401, "invalid or expired credential");

    const sid = req.headers.get("mcp-session-id");
    if (sid) {
      const s = this.sessions.get(sid);
      if (!s || s.credential !== credential) return rpcError(404, "session not found");
      return s.transport.handleRequest(req);
    }
    if (req.method !== "POST") return rpcError(400, "missing mcp-session-id");

    const server = this.buildServer(credential);
    const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, { server, transport, credential });
      },
      onsessionclosed: (id) => {
        this.sessions.delete(id);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    const res = await transport.handleRequest(req);
    if (!transport.sessionId) void server.close().catch(() => {});
    return res;
  }

  private buildServer(credential: Credential): Server {
    const server = new Server(
      { name: "vibe-center", version: "1.0.0" },
      { capabilities: { tools: { listChanged: true } }, instructions: GATEWAY_INSTRUCTIONS },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.catalog.enabled(credential.agentId).map((t) => ({
        name: t.exposedName,
        description: t.tool.description,
        inputSchema: t.tool.inputSchema as { type: "object" },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const meta = req.params._meta as Record<string, unknown> | undefined;
      const toolUseId =
        typeof meta?.["claudecode/toolUseId"] === "string" ? meta["claudecode/toolUseId"] : null;
      return this.call(credential, req.params.name, req.params.arguments ?? {}, toolUseId);
    });
    return server;
  }

  // ---- calls ------------------------------------------------------------------------------------

  /** Run one tool call for an agent session: check, log, dispatch, log the outcome. */
  async call(
    credential: Credential,
    name: string,
    args: Record<string, unknown>,
    toolUseId: string | null = null,
  ): Promise<ToolResult> {
    const tool = this.catalog.enabled(credential.agentId).find((t) => t.exposedName === name);
    if (!tool) {
      return errorResult(
        `The tool "${name}" is not available to this agent (not enabled, or it no longer exists).`,
      );
    }
    const builtin = tool.server.id === BUILTIN_SERVER_ID;
    const session = this.repos.conversations.session(credential.sessionKey);
    const ctx: ToolContext = {
      agentId: credential.agentId,
      sessionKey: credential.sessionKey,
      turnId: session ? this.repos.toolCalls.runningTurn(session.id) : null,
    };
    const rec = this.repos.toolCalls.start({
      agentId: credential.agentId,
      sessionId: session?.id ?? null,
      turnId: ctx.turnId,
      serverId: tool.server.id,
      server: tool.server.name,
      tool: tool.tool.name,
      args,
    });
    this.recorder.started(rec, { exposedName: name, toolUseId });

    let result: ToolResult;
    try {
      result = builtin
        ? await this.runBuiltin(tool, args, ctx)
        : await this.upstreams.call(tool.server, tool.tool.name, args);
    } catch (e) {
      result = errorResult(
        e instanceof ToolError ? e.message : `${tool.server.name} failed: ${errorText(e)}`,
      );
    }
    const done = this.repos.toolCalls.finish(rec.callId, resultText(result), !!result.isError);
    if (done) this.recorder.finished(done);
    return result;
  }

  private async runBuiltin(tool: ExposedTool, args: Record<string, unknown>, ctx: ToolContext) {
    const impl = this.builtins().get(tool.tool.name);
    if (!impl) throw new ToolError(`unknown built-in tool ${tool.tool.name}`);
    const parsed = impl.schema.safeParse(args);
    if (!parsed.success) throw new ToolError(`invalid arguments: ${z.prettifyError(parsed.error)}`);
    return impl.run(parsed.data as Record<string, unknown>, ctx);
  }
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function resultText(r: ToolResult): string {
  const parts = (r.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`));
  const s = parts.join("\n");
  return s.length > 20_000 ? `${s.slice(0, 20_000)}…` : s;
}

function rpcError(status: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }, { status });
}
