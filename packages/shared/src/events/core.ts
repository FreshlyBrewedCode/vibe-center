// Core live-update events (phase 1). Server → every connected device.
import type { AgentView, Harness, Message, Presence, Session } from "../domain.ts";

export type CoreEvent =
  /** First frame after the socket opens. Clients refetch everything they cache when they see it. */
  | { type: "hello"; deviceId: string; serverStartedAt: number }
  /** A message was created or changed (status, tool call progress, permission outcome, final text). */
  | { type: "message.upsert"; message: Message }
  /**
   * Streaming text appended to a message. `offset` is the text length before this delta: a client
   * whose cached text has a different length missed something and should refetch.
   */
  | { type: "message.delta"; conversationId: string; messageId: string; offset: number; text: string }
  | { type: "agent.upsert"; agent: AgentView }
  | { type: "agent.deleted"; agentId: string }
  | { type: "agent.presence"; agentId: string; presence: Presence; detail: string | null }
  | {
      type: "conversation.unread";
      conversationId: string;
      agentId: string;
      unread: number;
      lastReadSeq: number;
    }
  | { type: "session.started"; session: Session }
  | { type: "harness.upsert"; harness: Harness }
  /** The receiving device must drop its state and show the login screen if it is `deviceId`. */
  | { type: "device.revoked"; deviceId: string };
