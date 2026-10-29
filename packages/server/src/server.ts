import { Hono } from "hono";
import type { McpProvider } from "./acp/mcp.ts";
import type { RuntimeTimeouts } from "./acp/runtime.ts";
import { createApi } from "./http/api.ts";
import { staticHandler, WEB_DIST } from "./http/static.ts";
import { type WsData, WsHub } from "./http/ws.ts";
import { createServices, type Services } from "./services.ts";

export interface ServerOptions {
  dataDir: string;
  /** 0 picks a free port. */
  port: number;
  /** Always loopback: remote devices come in through `tailscale serve`. */
  hostname?: string;
  /** Serve the built SPA from here; null when Vite serves it (dev mode). */
  webDist?: string | null;
  /** SEAM (phase 2a): plug the MCP gateway in here. */
  mcp?: McpProvider;
  timeouts?: Partial<RuntimeTimeouts>;
  /** Probe every harness in the background on start (health + models). Off in tests. */
  probeOnStart?: boolean;
}

export interface AppServer {
  services: Services;
  port: number;
  /** http://localhost:<port>/ */
  localUrl: string;
  stop(): Promise<void>;
}

/** Boot the app: services, HTTP API, WebSocket channel and the SPA, on one loopback port. */
export function createServer(opts: ServerOptions): AppServer {
  const services = createServices({ dataDir: opts.dataDir, mcp: opts.mcp, timeouts: opts.timeouts });
  const hub = new WsHub(services);
  const app = new Hono();
  app.route("/api", createApi(services));
  // Phase 2a mounts the MCP gateway (e.g. app.route("/mcp", ...)) and 2b the voice bridge here.
  const serveStatic = opts.webDist === null ? null : staticHandler(opts.webDist ?? WEB_DIST);

  const server = Bun.serve<WsData>({
    port: opts.port,
    hostname: opts.hostname ?? "127.0.0.1",
    idleTimeout: 120,
    fetch(req, srv) {
      const { pathname } = new URL(req.url);
      if (pathname === "/ws") return hub.upgrade(req, srv);
      if (pathname.startsWith("/api/") || pathname === "/api") return app.fetch(req);
      if (serveStatic) return serveStatic(req);
      return new Response("not found", { status: 404 });
    },
    websocket: hub.handler,
  });
  hub.attach(server);
  if (opts.probeOnStart) services.harnesses.probeAll();

  const port = server.port!;
  return {
    services,
    port,
    localUrl: `http://localhost:${port}/`,
    async stop() {
      hub.close();
      await server.stop(true);
      await services.close();
    },
  };
}
