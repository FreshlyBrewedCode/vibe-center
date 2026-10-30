// The live event channel: one WebSocket per tab, reconnecting with backoff. Every event is
// applied to the TanStack Query cache in `applyEvent`, the one place that knows how events map
// onto cached server state. Features that need side effects (notifications, voice UI) use
// `subscribe`. Unknown event types are ignored, so the server can add events freely.
//
// The socket heals itself. A phone that locks its screen freezes the tab and its network can
// drop the connection without a `close` event, so the socket looks open but is dead: the client
// pings every 10 s and drops a socket that doesn't answer within 5 s. Coming back to the tab
// (visibilitychange, pageshow, online) checks it at once (3 s to answer). A reconnect (`hello`) or a resume
// refetches everything cached, so whatever was missed (messages, permission requests, presence,
// unread counts, calls) shows without a reload.

import type { QueryClient } from "@tanstack/react-query";
import type {
  AgentsResponse,
  CallsResponse,
  DevicesResponse,
  HarnessesResponse,
  McpServersResponse,
  Message,
  MessagesResponse,
  ServerEvent,
  ServerFrame,
} from "@vibe-center/shared";
import { paths } from "@vibe-center/shared";
import { useEffect, useSyncExternalStore } from "react";
import { keys } from "./queries";

type Listener = (e: ServerEvent) => void;
export type ConnectionState = "connecting" | "open" | "closed";

/** Ping interval while the socket is open. */
const HEARTBEAT_MS = 10_000;
/** A ping unanswered this long means the socket is dead. */
const PONG_TIMEOUT_MS = 5_000;
/** Back on the tab: a socket that doesn't answer this quickly is replaced. */
const RESUME_PROBE_MS = 3_000;
const CONNECT_TIMEOUT_MS = 10_000;

const listeners = new Set<Listener>();
let state: ConnectionState = "closed";
const stateListeners = new Set<() => void>();

function setState(next: ConnectionState) {
  if (state === next) return;
  state = next;
  for (const l of stateListeners) l();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useConnectionState(): ConnectionState {
  return useSyncExternalStore(
    (cb) => {
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },
    () => state,
  );
}

/** Refetch every cached query but the session: anything may have changed while we were away. */
export function resync(qc: QueryClient): void {
  void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "me" });
}

/** Keep the socket open and alive while mounted (the signed-in shell mounts it). */
export function useLiveEvents(qc: QueryClient, myDeviceId: string): void {
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let lastTick = 0;
    /** When the oldest unanswered ping went out; null when everything sent was answered. */
    let pingSentAt: number | null = null;
    /** Resync when the next frame proves the socket alive (we were away; events may be lost). */
    let resyncOnFrame = false;

    /** Ping, and drop the socket if nothing comes back within `timeoutMs`. */
    const ping = (timeoutMs: number) => {
      const socket = ws;
      if (!socket) return;
      pingSentAt ??= Date.now();
      try {
        socket.send(JSON.stringify({ type: "ping" }));
      } catch {}
      setTimeout(() => {
        if (ws !== socket || pingSentAt === null || Date.now() - pingSentAt < timeoutMs) return;
        drop();
        attempt = 0;
        scheduleReconnect(0);
      }, timeoutMs);
    };

    /** Abandon the current socket without waiting for a close that may never come. */
    const drop = () => {
      clearInterval(heartbeat);
      const dead = ws;
      ws = null;
      pingSentAt = null;
      resyncOnFrame = false; // the next socket's `hello` resyncs
      if (dead) {
        dead.onopen = dead.onmessage = dead.onclose = dead.onerror = null;
        try {
          dead.close(4000, "heartbeat timeout");
        } catch {}
      }
      setState("closed");
    };

    const scheduleReconnect = (delay: number) => {
      clearTimeout(retry);
      retry = setTimeout(connect, delay);
    };

    const tick = () => {
      const now = Date.now();
      const slept = now - lastTick > HEARTBEAT_MS * 2; // timers were frozen (a background tab)
      lastTick = now;
      if (slept) check();
      else ping(PONG_TIMEOUT_MS);
    };

    /** Back on the tab (or the network): make sure the socket works, now rather than later. */
    const check = () => {
      if (stopped) return;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        drop();
        attempt = 0;
        return scheduleReconnect(0);
      }
      if (ws.readyState !== WebSocket.OPEN) return; // still connecting
      // the socket may have survived while events didn't (a frozen tab): refetch once it answers
      resyncOnFrame = true;
      pingSentAt = null;
      ping(RESUME_PROBE_MS);
    };

    const connect = () => {
      if (stopped) return;
      clearTimeout(retry);
      setState("connecting");
      const url = new URL(paths.ws, location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url);
      ws = socket;
      // a handshake on a network that just came back can hang instead of failing
      setTimeout(() => {
        if (ws !== socket || socket.readyState !== WebSocket.CONNECTING) return;
        drop();
        scheduleReconnect(Math.min(10_000, 500 * 2 ** attempt++));
      }, CONNECT_TIMEOUT_MS);
      socket.onopen = () => {
        attempt = 0;
        setState("open");
        lastTick = Date.now();
        pingSentAt = null;
        heartbeat = setInterval(tick, HEARTBEAT_MS);
      };
      socket.onmessage = (m) => {
        pingSentAt = null;
        if (resyncOnFrame) {
          resyncOnFrame = false;
          resync(qc);
        }
        const frame = JSON.parse(String(m.data)) as ServerFrame;
        if (frame.type === "pong") return;
        applyEvent(qc, frame, myDeviceId);
        for (const l of listeners) l(frame);
      };
      socket.onclose = (e) => {
        drop();
        if (stopped) return;
        if (e.code === 4401) {
          void qc.invalidateQueries({ queryKey: keys.me });
          return;
        }
        // The upgrade fails without a valid session: re-check it, the shell signs out if so.
        if (attempt >= 1) void qc.invalidateQueries({ queryKey: keys.me });
        scheduleReconnect(Math.min(10_000, 500 * 2 ** attempt++));
      };
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", check);
    window.addEventListener("online", check);
    connect();
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", check);
      window.removeEventListener("online", check);
      clearTimeout(retry);
      drop();
    };
  }, [qc, myDeviceId]);
}

function patchMessages(
  qc: QueryClient,
  conversationId: string,
  fn: (messages: Message[]) => Message[] | null,
): void {
  const key = keys.messages(conversationId);
  const cur = qc.getQueryData<MessagesResponse>(key);
  if (!cur) return;
  const next = fn(cur.messages);
  if (next === null) void qc.invalidateQueries({ queryKey: key });
  else qc.setQueryData<MessagesResponse>(key, { ...cur, messages: next });
}

function patchAgents(qc: QueryClient, fn: (agents: AgentsResponse) => AgentsResponse): void {
  qc.setQueryData<AgentsResponse>(keys.agents, (cur) => (cur ? fn(cur) : cur));
}

export function applyEvent(qc: QueryClient, e: ServerEvent, myDeviceId: string): void {
  switch (e.type) {
    case "hello":
      // (Re)connected: anything may have changed while we were away.
      resync(qc);
      return;
    case "message.upsert":
      patchMessages(qc, e.message.conversationId, (list) => {
        const i = list.findIndex((m) => m.id === e.message.id);
        if (i >= 0) return list.with(i, e.message);
        return [...list, e.message].sort((a, b) => a.seq - b.seq);
      });
      return;
    case "message.delta":
      patchMessages(qc, e.conversationId, (list) => {
        const i = list.findIndex((m) => m.id === e.messageId);
        const m = list[i];
        // A gap (missed delta or message): refetch instead of showing garbled text.
        if (!m || m.text.length !== e.offset) return null;
        return list.with(i, { ...m, text: m.text + e.text } as Message);
      });
      return;
    case "agent.upsert":
      patchAgents(qc, (list) =>
        list.some((a) => a.id === e.agent.id)
          ? list.map((a) => (a.id === e.agent.id ? e.agent : a))
          : [...list, e.agent],
      );
      return;
    case "agent.deleted":
      patchAgents(qc, (list) => list.filter((a) => a.id !== e.agentId));
      return;
    case "agent.presence":
      patchAgents(qc, (list) =>
        list.map((a) => (a.id === e.agentId ? { ...a, presence: e.presence, presenceDetail: e.detail } : a)),
      );
      return;
    case "conversation.unread":
      patchAgents(qc, (list) => list.map((a) => (a.id === e.agentId ? { ...a, unread: e.unread } : a)));
      return;
    case "session.started":
      void qc.invalidateQueries({ queryKey: keys.conversation(e.session.conversationId) });
      return;
    case "harness.upsert":
      qc.setQueryData<HarnessesResponse>(keys.harnesses, (list) =>
        list
          ? list.some((h) => h.id === e.harness.id)
            ? list.map((h) => (h.id === e.harness.id ? e.harness : h))
            : [...list, e.harness]
          : list,
      );
      return;
    case "mcp.server.upsert":
      qc.setQueryData<McpServersResponse>(keys.mcpServers, (list) =>
        list
          ? list.some((s) => s.id === e.server.id)
            ? list.map((s) => (s.id === e.server.id ? e.server : s))
            : [...list, e.server]
          : list,
      );
      // Status and discovered tools show in the agents' tool groups too.
      void qc.invalidateQueries({ queryKey: ["agent-tools"] });
      return;
    case "mcp.server.deleted":
      qc.setQueryData<McpServersResponse>(keys.mcpServers, (l) => l?.filter((s) => s.id !== e.serverId));
      void qc.invalidateQueries({ queryKey: ["agent-tools"] });
      return;
    case "agent.tools.changed":
      void qc.invalidateQueries({ queryKey: e.agentId ? keys.agentTools(e.agentId) : ["agent-tools"] });
      return;
    case "memory.upsert":
    case "memory.deleted":
      void qc.invalidateQueries({ queryKey: ["memories"] });
      return;
    case "call.upsert":
      qc.setQueryData<CallsResponse>(keys.calls, (list) => {
        const rest = (list ?? []).filter((c) => c.id !== e.call.id);
        return e.call.state === "ended" ? rest : [...rest, e.call];
      });
      return;
    case "voice.status":
      qc.setQueryData(keys.voiceStatus, e.status);
      return;
    case "device.revoked":
      if (e.deviceId === myDeviceId) qc.setQueryData(keys.me, null);
      else void qc.invalidateQueries({ queryKey: keys.devices });
      return;
    case "device.upsert":
      // Broadcast: `current` is relative to whichever device published it, not us. Keep ours.
      qc.setQueryData<DevicesResponse>(keys.devices, (list) =>
        list
          ? list.some((d) => d.id === e.device.id)
            ? list.map((d) => (d.id === e.device.id ? { ...e.device, current: d.current } : d))
            : [...list, e.device]
          : list,
      );
      return;
    case "device.link.paired":
      // No cache to patch here: the Add device dialog picks this up via `subscribe()`.
      return;
    default:
      return;
  }
}
