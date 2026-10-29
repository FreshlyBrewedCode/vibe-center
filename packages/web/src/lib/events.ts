// The live event channel: one WebSocket per tab, reconnecting with backoff. Every event is
// applied to the TanStack Query cache in `applyEvent`, the one place that knows how events map
// onto cached server state. Features that need side effects (notifications, voice UI) use
// `subscribe`. Unknown event types are ignored, so the server can add events freely.

import type { QueryClient } from "@tanstack/react-query";
import type {
  AgentsResponse,
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

const listeners = new Set<Listener>();
let state: ConnectionState = "closed";
const stateListeners = new Set<() => void>();

function setState(next: ConnectionState) {
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

/** Keep the socket open while mounted (the signed-in shell mounts it). */
export function useLiveEvents(qc: QueryClient, myDeviceId: string): void {
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;

    const connect = () => {
      setState("connecting");
      const url = new URL(paths.ws, location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(url);
      ws.onopen = () => {
        attempt = 0;
        setState("open");
        ping = setInterval(() => ws?.send(JSON.stringify({ type: "ping" })), 25_000);
      };
      ws.onmessage = (m) => {
        const frame = JSON.parse(String(m.data)) as ServerFrame;
        if (frame.type === "pong") return;
        applyEvent(qc, frame, myDeviceId);
        for (const l of listeners) l(frame);
      };
      ws.onclose = (e) => {
        clearInterval(ping);
        setState("closed");
        if (stopped) return;
        if (e.code === 4401) {
          void qc.invalidateQueries({ queryKey: keys.me });
          return;
        }
        // The upgrade fails without a valid session: re-check it, the shell signs out if so.
        if (attempt >= 1) void qc.invalidateQueries({ queryKey: keys.me });
        const delay = Math.min(10_000, 500 * 2 ** attempt++);
        retry = setTimeout(connect, delay);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(ping);
      ws?.close();
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
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "me" });
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
    case "device.revoked":
      if (e.deviceId === myDeviceId) qc.setQueryData(keys.me, null);
      else void qc.invalidateQueries({ queryKey: keys.devices });
      return;
    default:
      return;
  }
}
