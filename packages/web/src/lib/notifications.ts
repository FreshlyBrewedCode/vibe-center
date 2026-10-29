// Browser notifications for an agent finishing a reply or asking for approval while its DM
// isn't the visible route (or the tab is backgrounded). Permission + the on/off toggle are a
// local preference (there's only one user), not server state.
import type { AgentView, ServerEvent } from "@vibe-center/shared";
import { useEffect } from "react";
import { subscribe } from "./events";

const KEY = "vc-notifications";

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationPermission(): NotificationPermission {
  return notificationsSupported() ? Notification.permission : "denied";
}

export function notificationsEnabled(): boolean {
  return localStorage.getItem(KEY) === "1" && notificationPermission() === "granted";
}

export function setNotificationsEnabled(on: boolean): void {
  localStorage.setItem(KEY, on ? "1" : "0");
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  return Notification.requestPermission();
}

/** Mounted once in the signed-in shell. `activeAgentId` is the agent whose DM is on screen. */
export function useAgentNotifications(agents: AgentView[] | undefined, activeAgentId: string | null): void {
  useEffect(() => {
    return subscribe((e: ServerEvent) => {
      if (!notificationsEnabled() || !agents) return;
      if (e.type !== "message.upsert") return;
      const m = e.message;
      if (m.role !== "agent") return;
      const agent = agents.find((a) => a.conversationId === m.conversationId);
      if (!agent) return;
      const dmVisible = document.visibilityState === "visible" && agent.id === activeAgentId;
      if (dmVisible) return;
      if (m.kind === "text" && m.status === "complete" && m.text.trim()) {
        notify(agent.name, m.text.slice(0, 140), agent.id);
      } else if (m.kind === "permission" && m.status === "pending") {
        notify(agent.name, `Needs approval: ${m.data.title}`, agent.id);
      }
    });
  }, [agents, activeAgentId]);
}

function notify(title: string, body: string, agentId: string): void {
  const n = new Notification(title, { body, tag: `vc-agent-${agentId}` });
  n.onclick = () => {
    window.focus();
    location.assign(`/agents/${agentId}`);
    n.close();
  };
}
