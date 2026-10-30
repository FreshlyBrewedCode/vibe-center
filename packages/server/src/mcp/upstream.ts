import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerStatus, McpToolInfo } from "@vibe-center/shared";
import { expandHome } from "../config.ts";
import type { McpServerRecord } from "../db/repos/mcp-servers.ts";
import type { ToolResult } from "./builtin/index.ts";
import { NeedsSignInError } from "./oauth.ts";

const CONNECT_TIMEOUT_MS = 30_000;
/** Upstream tool calls can be long (builds, browsers); progress notifications extend it. */
const CALL_TIMEOUT_MS = 10 * 60_000;

/** Background calls (watches) wait longer than a turn would, and can be cancelled. */
export interface CallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface UpstreamEvents {
  status(serverId: string, status: McpServerStatus): void;
  tools(serverId: string, tools: McpToolInfo[]): void;
  /** The fetch for an HTTP server's transport (OAuth adds its bearer token); undefined = plain. */
  fetchFor?(record: McpServerRecord): FetchLike | undefined;
}

/** A connected client to one configured server plus what's needed to report its health. */
class Upstream {
  client: Client | null = null;
  connecting: Promise<Client> | null = null;
  stderr: string[] = [];
  closed = false;

  constructor(
    readonly record: McpServerRecord,
    private readonly events: UpstreamEvents,
  ) {}

  connect(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async open(): Promise<Client> {
    this.report({ state: "connecting", message: null, serverInfo: null });
    try {
      const client = await this.openClient();
      if (this.closed) {
        await client.close();
        throw new Error("closed");
      }
      this.client = client;
      client.onclose = () => {
        if (this.client !== client) return;
        this.client = null;
        if (!this.closed) {
          this.report({ state: "error", message: this.withStderr("the server closed the connection") });
        }
      };
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        void this.discover(client).catch(() => {});
      });
      await this.discover(client);
      const info = client.getServerVersion();
      this.report({
        state: "connected",
        message: null,
        serverInfo: info ? { name: info.name, version: info.version } : null,
      });
      return client;
    } catch (e) {
      // A needed sign-in was reported as `needs_auth` by the OAuth layer already.
      if (!this.closed && !(e instanceof NeedsSignInError)) {
        this.report({ state: "error", message: this.withStderr(errorText(e)) });
      }
      throw e;
    }
  }

  private async openClient(): Promise<Client> {
    const r = this.record;
    const make = () => new Client({ name: "vibe-center", version: "1.0.0" });
    if (r.transport === "stdio") {
      const t = new StdioClientTransport({
        command: r.command ?? "",
        args: r.args,
        env: { ...getDefaultEnvironment(), ...r.env },
        cwd: r.cwd ? expandHome(r.cwd) : undefined,
        stderr: "pipe",
      });
      t.stderr?.on("data", (chunk: Buffer) => {
        this.stderr.push(...String(chunk).split("\n").filter(Boolean));
        if (this.stderr.length > 20) this.stderr.splice(0, this.stderr.length - 20);
      });
      return this.connectWith(make(), t);
    }
    const url = new URL(r.url ?? "");
    const requestInit = { headers: r.headers };
    const fetch = this.events.fetchFor?.(r);
    try {
      return await this.connectWith(make(), new StreamableHTTPClientTransport(url, { requestInit, fetch }));
    } catch (e) {
      if (e instanceof NeedsSignInError) throw e;
      // Older servers speak the deprecated HTTP+SSE transport.
      try {
        return await this.connectWith(make(), new SSEClientTransport(url, { requestInit, fetch }));
      } catch {
        throw e;
      }
    }
  }

  private async connectWith(client: Client, transport: Transport): Promise<Client> {
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      return client;
    } catch (e) {
      await client.close().catch(() => {});
      throw e;
    }
  }

  private async discover(client: Client): Promise<void> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      for (const t of page.tools) {
        tools.push({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema });
      }
      cursor = page.nextCursor;
    } while (cursor);
    this.events.tools(this.record.id, tools);
  }

  async call(name: string, args: Record<string, unknown>, opts: CallOptions = {}): Promise<ToolResult> {
    const client = await this.connect();
    const res = await client.callTool({ name, arguments: args }, undefined, {
      timeout: opts.timeoutMs ?? CALL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
      signal: opts.signal,
    });
    return res as ToolResult; // `toolResult` (pre-2024 servers) is not supported
  }

  async close(): Promise<void> {
    this.closed = true;
    const client = this.client ?? (await this.connecting?.catch(() => null)) ?? null;
    this.client = null;
    await client?.close().catch(() => {});
  }

  private report(s: Omit<McpServerStatus, "checkedAt" | "serverInfo"> & Partial<McpServerStatus>): void {
    this.events.status(this.record.id, {
      serverInfo: null,
      ...s,
      checkedAt: Date.now(),
    } as McpServerStatus);
  }

  private withStderr(msg: string): string {
    const tail = this.stderr.slice(-5).join("\n");
    return tail ? `${msg}\n${tail}` : msg;
  }
}

/**
 * One client per configured upstream MCP server, shared by every agent session (a stdio server
 * runs once, not per session). Connects lazily and reconnects after a crash on the next use.
 */
export class UpstreamPool {
  private upstreams = new Map<string, Upstream>();

  constructor(private readonly events: UpstreamEvents) {}

  private get(record: McpServerRecord): Upstream {
    let u = this.upstreams.get(record.id);
    if (!u) {
      u = new Upstream(record, this.events);
      this.upstreams.set(record.id, u);
    }
    return u;
  }

  /** (Re)connect and rediscover tools. Rejects with the connection error. */
  async refresh(record: McpServerRecord): Promise<void> {
    await this.drop(record.id);
    await this.get(record).connect();
  }

  async call(
    record: McpServerRecord,
    tool: string,
    args: Record<string, unknown>,
    opts?: CallOptions,
  ): Promise<ToolResult> {
    return this.get(record).call(tool, args, opts);
  }

  /** Disconnect (stops a stdio server's process). The next use connects again. */
  async drop(serverId: string): Promise<void> {
    const u = this.upstreams.get(serverId);
    this.upstreams.delete(serverId);
    await u?.close();
  }

  async close(): Promise<void> {
    await Promise.all([...this.upstreams.keys()].map((id) => this.drop(id)));
  }
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
