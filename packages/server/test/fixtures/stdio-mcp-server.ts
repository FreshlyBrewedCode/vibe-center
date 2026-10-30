#!/usr/bin/env bun
// A small stdio MCP server for the gateway tests: echo, add, env (reads an env var, to check that
// configured secrets reach the server), fail (returns an error), grow (registers a new tool and
// announces it with tools/list_changed), wait (blocks for `ms`, like a wait-for-thread tool).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "test-upstream", version: "0.1.0" });
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

server.registerTool(
  "echo",
  { description: "Echo the text back.", inputSchema: { text: z.string() } },
  ({ text: t }) => text(`echo: ${t}`),
);
server.registerTool(
  "add",
  { description: "Add two numbers.", inputSchema: { a: z.number(), b: z.number() } },
  ({ a, b }) => text(String(a + b)),
);
server.registerTool(
  "env",
  { description: "Read an environment variable.", inputSchema: { name: z.string() } },
  ({ name }) => text(process.env[name] ?? "(unset)"),
);
server.registerTool(
  "wait",
  { description: "Wait, then answer.", inputSchema: { ms: z.number(), text: z.string() } },
  async ({ ms, text: t }) => {
    await Bun.sleep(ms);
    return text(`waited: ${t}`);
  },
);
server.registerTool("fail", { description: "Always fails." }, () => ({
  content: [{ type: "text" as const, text: "it broke" }],
  isError: true,
}));
server.registerTool("grow", { description: "Adds a tool named `extra`." }, () => {
  server.registerTool("extra", { description: "Appeared later." }, () => text("extra!"));
  return text("grown");
});

await server.connect(new StdioServerTransport());
