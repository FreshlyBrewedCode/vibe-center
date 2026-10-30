import { voicePaths } from "@vibe-center/shared";
import type { Server } from "bun";
import { Hono } from "hono";
import type { McpProvider } from "./acp/mcp.ts";
import type { RuntimeTimeouts } from "./acp/runtime.ts";
import { createApi } from "./http/api.ts";
import { createMcpApi } from "./http/mcp-api.ts";
import { staticHandler, WEB_DIST } from "./http/static.ts";
import { type WsData, WsHub } from "./http/ws.ts";
import { GATEWAY_PATH } from "./mcp/gateway.ts";
import { createServices, type Services } from "./services.ts";
import type { BridgeSocketData } from "./voice/bridge.ts";
import { createVoiceApi } from "./voice/http.ts";
import type { VoiceOptions } from "./voice/service.ts";

type SocketData = WsData | BridgeSocketData;
const isBridge = (d: SocketData): d is BridgeSocketData => "bridgeCallId" in d;

export interface ServerOptions {
  dataDir: string;
  /** 0 picks a free port. */
  port: number;
  /** Always loopback: remote devices come in through `tailscale serve`. */
  hostname?: string;
  /** Serve the built SPA from here; null when Vite serves it (dev mode). */
  webDist?: string | null;
  /** Overrides the MCP provider for ACP sessions (default: the app's gateway at /mcp). */
  mcp?: McpProvider;
  timeouts?: Partial<RuntimeTimeouts>;
  /** Probe every harness in the background on start (health + models). Off in tests. */
  probeOnStart?: boolean;
  /** Voice worker management (phase 2b). The CLI autostarts the managed worker. */
  voice?: VoiceOptions;
  /** Drop an event socket whose client sent nothing for this long (default `WS_SILENT_MS`). */
  wsSilentMs?: number;
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
  const services = createServices({
    dataDir: opts.dataDir,
    mcp: opts.mcp,
    timeouts: opts.timeouts,
    voice: opts.voice,
  });
  const hub = new WsHub(services, opts.wsSilentMs);
  const app = new Hono();
  app.route("/api/voice", createVoiceApi(services));
  app.route("/api", createApi(services));
  app.route("/api", createMcpApi(services));
  const serveStatic = opts.webDist === null ? null : staticHandler(opts.webDist ?? WEB_DIST);

  const voice = services.voice;
  const server = Bun.serve<SocketData>({
    port: opts.port,
    hostname: opts.hostname ?? "127.0.0.1",
    idleTimeout: 120,
    fetch(req, srv) {
      const { pathname } = new URL(req.url);
      if (pathname === "/ws") return hub.upgrade(req, srv as Server<WsData>);
      if (pathname === voicePaths.bridge) return voice.upgrade(req, srv as Server<BridgeSocketData>);
      if (pathname === GATEWAY_PATH) return services.mcp.gateway.handle(req);
      if (pathname.startsWith("/api/") || pathname === "/api") return app.fetch(req);
      if (serveStatic) return serveStatic(req);
      return new Response("not found", { status: 404 });
    },
    // one handler per socket kind: the event channel, or a voice worker's bridge
    websocket: {
      open: (ws) => {
        if (isBridge(ws.data)) voice.socketHandler.open?.(ws as never);
        else hub.handler.open?.(ws as never);
      },
      message: (ws, m) => {
        if (isBridge(ws.data)) voice.socketHandler.message?.(ws as never, m);
        else hub.handler.message?.(ws as never, m);
      },
      close: (ws, code, reason) => {
        if (isBridge(ws.data)) voice.socketHandler.close?.(ws as never, code, reason);
        else hub.handler.close?.(ws as never, code, reason);
      },
    },
  });
  hub.attach(server as Server<WsData>);
  void voice.start(server.port!);
  const port = server.port!;
  services.mcp.gateway.setBaseUrl(`http://127.0.0.1:${port}`);
  if (opts.probeOnStart) {
    services.harnesses.probeAll();
    services.mcp.connectAll();
  }

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
