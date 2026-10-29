// Tiny stdio MCP server standing in for the "manager" tools of the voice agent.
// Every tool returns immediately. Invocations are appended as JSONL (epoch ms) to
// $TOOL_LOG so the harness can line them up with ACP tool_call updates.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { appendFileSync } from "node:fs";
import { z } from "zod";

const started = Date.now();
const logFile = process.env.TOOL_LOG;
const log = (entry: Record<string, unknown>) => {
  if (logFile) appendFileSync(logFile, JSON.stringify({ t: Date.now(), ...entry }) + "\n");
};

const SESSIONS = [
  { session: "frontend", status: "idle", task: "finished the navbar refactor 4 min ago" },
  { session: "backend", status: "working", task: "running database migrations" },
  { session: "docs", status: "waiting_for_input", task: "asks whether to document the v2 API" },
];

const server = new McpServer({ name: "voice", version: "0.0.1" });
let nextId = 1;

server.registerTool(
  "list_sessions",
  { description: "List the coding agent sessions you manage and what each is doing.", inputSchema: {} },
  async () => {
    log({ tool: "list_sessions", phase: "start" });
    const res = { content: [{ type: "text" as const, text: JSON.stringify(SESSIONS) }] };
    log({ tool: "list_sessions", phase: "end" });
    return res;
  },
);

server.registerTool(
  "dispatch_task",
  {
    description:
      "Send an instruction to a coding agent session. Fire-and-forget: returns immediately with a task id.",
    inputSchema: { session: z.string(), instruction: z.string() },
  },
  async ({ session, instruction }) => {
    log({ tool: "dispatch_task", phase: "start", session, instruction });
    const res = {
      content: [{ type: "text" as const, text: JSON.stringify({ status: "dispatched", id: `t${nextId++}` }) }],
    };
    log({ tool: "dispatch_task", phase: "end" });
    return res;
  },
);

await server.connect(new StdioServerTransport());
log({ event: "mcp_ready", bootMs: Date.now() - started });
