import {
  AgentToolsPatchBody,
  type AgentToolsResponse,
  McpOAuthCallbackBody,
  type McpOAuthCallbackResponse,
  McpOAuthStartBody,
  type McpOAuthStartResponse,
  McpServerBody,
  McpServerPatchBody,
  type McpServersResponse,
  type McpServerView,
  MemoriesQuery,
  type MemoriesResponse,
  type Memory,
  MemoryBody,
  MemoryPatchBody,
} from "@vibe-center/shared";
import { Hono } from "hono";
import type { Services } from "../services.ts";
import { type AuthedEnv, handleError, requireDevice, sameOrigin } from "./middleware.ts";

/**
 * Phase 2a routes under /api: MCP servers, per-agent tool selection, memories. Browser-facing
 * like the core API (device cookie, same-origin). The gateway itself (/mcp) is separate and
 * authenticates harness sessions by their own credential.
 */
export function createMcpApi(s: Services): Hono<AuthedEnv> {
  const api = new Hono<AuthedEnv>();
  api.onError(handleError);
  api.use(sameOrigin, requireDevice(s));

  api.get("/mcp/servers", (c) => c.json<McpServersResponse>(s.mcp.list()));
  api.post("/mcp/servers", async (c) =>
    c.json<McpServerView>(s.mcp.create(McpServerBody.parse(await c.req.json())), 201),
  );
  api.get("/mcp/servers/:id", (c) => c.json<McpServerView>(s.mcp.get(c.req.param("id"))));
  api.patch("/mcp/servers/:id", async (c) =>
    c.json<McpServerView>(s.mcp.update(c.req.param("id"), McpServerPatchBody.parse(await c.req.json()))),
  );
  api.delete("/mcp/servers/:id", async (c) => {
    await s.mcp.delete(c.req.param("id"));
    return c.body(null, 204);
  });
  api.post("/mcp/servers/:id/refresh", async (c) =>
    c.json<McpServerView>(await s.mcp.refresh(c.req.param("id"))),
  );

  // OAuth sign-in for HTTP servers. The redirect URI is on the origin this device uses (its
  // session cookie lives there); `sameOrigin` already refused a foreign Origin.
  api.post("/mcp/servers/:id/oauth", async (c) => {
    const origin = c.req.header("origin") ?? s.publicUrl ?? new URL(c.req.url).origin;
    const body = McpOAuthStartBody.parse(await c.req.json().catch(() => ({})));
    return c.json<McpOAuthStartResponse>(
      await s.mcp.startOAuth(c.req.param("id"), c.get("device").id, origin, body),
    );
  });
  api.delete("/mcp/servers/:id/oauth", async (c) =>
    c.json<McpServerView>(await s.mcp.disconnectOAuth(c.req.param("id"))),
  );
  api.post("/mcp/oauth/callback", async (c) =>
    c.json<McpOAuthCallbackResponse>(
      await s.mcp.completeOAuth(McpOAuthCallbackBody.parse(await c.req.json()), c.get("device").id),
    ),
  );

  api.get("/agents/:id/tools", (c) => c.json<AgentToolsResponse>(s.mcp.agentTools(c.req.param("id"))));
  api.patch("/agents/:id/tools", async (c) =>
    c.json<AgentToolsResponse>(
      s.mcp.setAgentTool(c.req.param("id"), AgentToolsPatchBody.parse(await c.req.json())),
    ),
  );

  api.get("/memories", (c) => c.json<MemoriesResponse>(s.mcp.memories(MemoriesQuery.parse(c.req.query()))));
  api.post("/memories", async (c) =>
    c.json<Memory>(s.mcp.createMemory(MemoryBody.parse(await c.req.json())), 201),
  );
  api.patch("/memories/:id", async (c) =>
    c.json<Memory>(s.mcp.updateMemory(c.req.param("id"), MemoryPatchBody.parse(await c.req.json()))),
  );
  api.delete("/memories/:id", (c) => {
    s.mcp.deleteMemory(c.req.param("id"));
    return c.body(null, 204);
  });

  return api;
}
