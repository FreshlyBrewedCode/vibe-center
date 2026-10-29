import type { ClientFrame, ServerEvent, ServerFrame } from "@vibe-center/shared";
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { SESSION_COOKIE } from "../auth/auth.ts";
import type { Services } from "../services.ts";
import { originAllowed } from "./origin.ts";

export interface WsData {
  deviceId: string;
}

const ALL = "events";

/**
 * The live-update channel: one socket per open tab, every ServerEvent goes to every device
 * (single user). Clients only send keep-alive pings; mutations go through HTTP. A revoked
 * device's sockets are closed after it got the `device.revoked` event.
 */
export class WsHub {
  private server: Server<WsData> | null = null;
  private sockets = new Map<string, Set<ServerWebSocket<WsData>>>();
  private readonly startedAt = Date.now();
  private unsubscribe: () => void;

  constructor(private readonly s: Services) {
    this.unsubscribe = s.bus.subscribe((event) => this.broadcast(event));
  }

  attach(server: Server<WsData>): void {
    this.server = server;
  }

  /** Upgrade an authenticated same-origin request, or return the error response. */
  upgrade(req: Request, server: Server<WsData>): Response | undefined {
    if (!originAllowed(req)) return new Response("cross-origin websocket refused", { status: 403 });
    const secret = cookie(req, SESSION_COOKIE);
    const device = this.s.auth.authenticate(secret);
    if (!device) return new Response("not signed in", { status: 401 });
    if (server.upgrade(req, { data: { deviceId: device.id } })) return undefined;
    return new Response("expected a websocket upgrade", { status: 400 });
  }

  readonly handler: WebSocketHandler<WsData> = {
    data: {} as WsData,
    open: (ws) => {
      ws.subscribe(ALL);
      const set = this.sockets.get(ws.data.deviceId) ?? new Set();
      set.add(ws);
      this.sockets.set(ws.data.deviceId, set);
      send(ws, { type: "hello", deviceId: ws.data.deviceId, serverStartedAt: this.startedAt });
    },
    message: (ws, raw) => {
      let frame: ClientFrame | null = null;
      try {
        frame = JSON.parse(String(raw)) as ClientFrame;
      } catch {}
      if (frame?.type === "ping") send(ws, { type: "pong" });
    },
    close: (ws) => {
      this.sockets.get(ws.data.deviceId)?.delete(ws);
    },
  };

  close(): void {
    this.unsubscribe();
    for (const set of this.sockets.values()) for (const ws of set) ws.close(1001, "server stopping");
  }

  private broadcast(event: ServerEvent): void {
    this.server?.publish(ALL, JSON.stringify(event));
    if (event.type === "device.revoked") {
      for (const ws of this.sockets.get(event.deviceId) ?? []) ws.close(4401, "device revoked");
      this.sockets.delete(event.deviceId);
    }
  }
}

function send(ws: ServerWebSocket<WsData>, frame: ServerFrame): void {
  ws.send(JSON.stringify(frame));
}

function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}
