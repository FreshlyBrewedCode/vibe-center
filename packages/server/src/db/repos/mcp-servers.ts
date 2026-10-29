import type { GatewayCallInfo, McpServerStatus, McpToolInfo, McpTransport } from "@vibe-center/shared";
import { type Db, json, newId } from "../index.ts";

/** An MCP server as stored, secrets included. Only the server side ever sees this shape. */
export interface McpServerRecord {
  id: string;
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
  url: string | null;
  headers: Record<string, string>;
  enabled: boolean;
  tools: McpToolInfo[];
  status: McpServerStatus;
  createdAt: number;
  updatedAt: number;
}

export type McpServerFields = Pick<
  McpServerRecord,
  "name" | "transport" | "command" | "args" | "env" | "cwd" | "url" | "headers" | "enabled"
>;

interface Row {
  id: string;
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string;
  env: string;
  cwd: string | null;
  url: string | null;
  headers: string;
  enabled: number;
  tools: string | null;
  status: string | null;
  created_at: number;
  updated_at: number;
}

export const UNKNOWN_STATUS: McpServerStatus = {
  state: "unknown",
  message: null,
  serverInfo: null,
  checkedAt: null,
};

const toRecord = (r: Row): McpServerRecord => ({
  id: r.id,
  name: r.name,
  transport: r.transport,
  command: r.command,
  args: json.parse(r.args, []),
  env: json.parse(r.env, {}),
  cwd: r.cwd,
  url: r.url,
  headers: json.parse(r.headers, {}),
  enabled: r.enabled === 1,
  tools: json.parse(r.tools, []),
  status: json.parse(r.status, UNKNOWN_STATUS),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class McpServerRepo {
  constructor(private readonly db: Db) {}

  list(): McpServerRecord[] {
    // The built-in server first, then in creation order.
    return this.db
      .query<Row, []>("SELECT * FROM mcp_servers ORDER BY transport != 'builtin', created_at")
      .all()
      .map(toRecord);
  }

  get(id: string): McpServerRecord | null {
    const r = this.db.query<Row, [string]>("SELECT * FROM mcp_servers WHERE id = ?").get(id);
    return r ? toRecord(r) : null;
  }

  byName(name: string): McpServerRecord | null {
    const r = this.db.query<Row, [string]>("SELECT * FROM mcp_servers WHERE name = ?").get(name);
    return r ? toRecord(r) : null;
  }

  insert(f: McpServerFields): McpServerRecord {
    const id = newId();
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO mcp_servers (id, name, transport, command, args, env, cwd, url, headers, enabled,
                                  created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        f.name,
        f.transport,
        f.command,
        json.str(f.args),
        json.str(f.env),
        f.cwd,
        f.url,
        json.str(f.headers),
        f.enabled ? 1 : 0,
        now,
        now,
      );
    return this.get(id)!;
  }

  update(id: string, f: McpServerFields): McpServerRecord | null {
    this.db
      .query(
        `UPDATE mcp_servers SET name = ?, transport = ?, command = ?, args = ?, env = ?, cwd = ?, url = ?,
                                headers = ?, enabled = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        f.name,
        f.transport,
        f.command,
        json.str(f.args),
        json.str(f.env),
        f.cwd,
        f.url,
        json.str(f.headers),
        f.enabled ? 1 : 0,
        Date.now(),
        id,
      );
    return this.get(id);
  }

  setStatus(id: string, status: McpServerStatus): void {
    this.db.query("UPDATE mcp_servers SET status = ? WHERE id = ?").run(json.str(status), id);
  }

  setTools(id: string, tools: McpToolInfo[]): void {
    this.db.query("UPDATE mcp_servers SET tools = ? WHERE id = ?").run(json.str(tools), id);
  }

  delete(id: string): void {
    this.db.query("DELETE FROM mcp_servers WHERE id = ?").run(id);
  }
}

/** Per-agent tool enablement rows. `tool_name '*'` is the server toggle. */
export class AgentToolRepo {
  constructor(private readonly db: Db) {}

  /** server id → tool name ('*' = server) → enabled. */
  forAgent(agentId: string): Map<string, Map<string, boolean>> {
    const rows = this.db
      .query<{ server_id: string; tool_name: string; enabled: number }, [string]>(
        "SELECT server_id, tool_name, enabled FROM agent_tools WHERE agent_id = ?",
      )
      .all(agentId);
    const out = new Map<string, Map<string, boolean>>();
    for (const r of rows) {
      const m = out.get(r.server_id) ?? new Map<string, boolean>();
      m.set(r.tool_name, r.enabled === 1);
      out.set(r.server_id, m);
    }
    return out;
  }

  set(agentId: string, serverId: string, tool: string, enabled: boolean): void {
    this.db
      .query(
        `INSERT INTO agent_tools (agent_id, server_id, tool_name, enabled) VALUES (?, ?, ?, ?)
         ON CONFLICT (agent_id, server_id, tool_name) DO UPDATE SET enabled = excluded.enabled`,
      )
      .run(agentId, serverId, tool, enabled ? 1 : 0);
  }

  /** Drop the per-tool overrides of one server (keeps the server toggle). */
  clearToolOverrides(agentId: string, serverId: string): void {
    this.db
      .query("DELETE FROM agent_tools WHERE agent_id = ? AND server_id = ? AND tool_name != '*'")
      .run(agentId, serverId);
  }
}

export interface ToolCallRecord extends GatewayCallInfo {
  agentId: string;
  sessionId: string | null;
  turnId: string | null;
  messageId: string | null;
  startedAt: number;
}

interface CallRow {
  id: string;
  agent_id: string;
  session_id: string | null;
  turn_id: string | null;
  message_id: string | null;
  server_name: string;
  tool: string;
  args: string;
  result: string | null;
  is_error: number;
  started_at: number;
  ended_at: number | null;
}

const toCall = (r: CallRow): ToolCallRecord => ({
  callId: r.id,
  agentId: r.agent_id,
  sessionId: r.session_id,
  turnId: r.turn_id,
  messageId: r.message_id,
  server: r.server_name,
  tool: r.tool,
  args: json.parse(r.args, {}),
  result: r.result,
  isError: r.is_error === 1,
  status: r.ended_at === null ? "running" : r.is_error ? "failed" : "completed",
  durationMs: r.ended_at === null ? null : r.ended_at - r.started_at,
  startedAt: r.started_at,
});

/** The gateway's log of served tool calls. */
export class ToolCallRepo {
  constructor(private readonly db: Db) {}

  start(c: {
    agentId: string;
    sessionId: string | null;
    turnId: string | null;
    serverId: string | null;
    server: string;
    tool: string;
    args: unknown;
  }): ToolCallRecord {
    const id = newId();
    this.db
      .query(
        `INSERT INTO mcp_tool_calls (id, agent_id, session_id, turn_id, server_id, server_name, tool, args,
                                     started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, c.agentId, c.sessionId, c.turnId, c.serverId, c.server, c.tool, json.str(c.args), Date.now());
    return this.get(id)!;
  }

  finish(id: string, result: string, isError: boolean): ToolCallRecord | null {
    this.db
      .query("UPDATE mcp_tool_calls SET result = ?, is_error = ?, ended_at = ? WHERE id = ?")
      .run(result, isError ? 1 : 0, Date.now(), id);
    return this.get(id);
  }

  setMessage(id: string, messageId: string): void {
    this.db.query("UPDATE mcp_tool_calls SET message_id = ? WHERE id = ?").run(messageId, id);
  }

  get(id: string): ToolCallRecord | null {
    const r = this.db.query<CallRow, [string]>("SELECT * FROM mcp_tool_calls WHERE id = ?").get(id);
    return r ? toCall(r) : null;
  }

  /** Calls of a turn not yet matched to a harness tool_call message, oldest first. */
  unlinked(turnId: string): ToolCallRecord[] {
    return this.db
      .query<CallRow, [string]>(
        "SELECT * FROM mcp_tool_calls WHERE turn_id = ? AND message_id IS NULL ORDER BY started_at",
      )
      .all(turnId)
      .map(toCall);
  }

  /** The running turn of an app session, i.e. the turn a gateway call belongs to. */
  runningTurn(sessionId: string): string | null {
    return (
      this.db
        .query<{ id: string }, [string]>(
          "SELECT id FROM turns WHERE session_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
        )
        .get(sessionId)?.id ?? null
    );
  }

  recent(agentId: string, limit: number): ToolCallRecord[] {
    return this.db
      .query<CallRow, [string, number]>(
        "SELECT * FROM mcp_tool_calls WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?",
      )
      .all(agentId, limit)
      .map(toCall);
  }
}
