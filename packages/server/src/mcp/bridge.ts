#!/usr/bin/env bun
// stdio ↔ streamable-HTTP bridge to the app's MCP gateway, for harnesses that can only start
// stdio MCP servers (no `mcpCapabilities.http`). The gateway hands it out in session/new with
// VIBE_MCP_URL and VIBE_MCP_TOKEN in its env; it forwards JSON-RPC messages unchanged.
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const url = process.env.VIBE_MCP_URL;
const token = process.env.VIBE_MCP_TOKEN;
if (!url || !token) {
  console.error("vibe-center MCP bridge: VIBE_MCP_URL and VIBE_MCP_TOKEN must be set");
  process.exit(2);
}

const upstream = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const local = new StdioServerTransport();

local.onmessage = (m) => {
  upstream.send(m).catch((e) => console.error("bridge: send failed:", (e as Error).message));
};
upstream.onmessage = (m) => {
  void local.send(m);
};
upstream.onerror = (e) => console.error("bridge:", e.message);
const stop = () => {
  void upstream.close();
  process.exit(0);
};
local.onclose = stop;
process.stdin.on("end", stop);

await upstream.start();
await local.start();
