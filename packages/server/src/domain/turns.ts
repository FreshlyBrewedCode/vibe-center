import type {
  Message,
  MessageStatus,
  PermissionData,
  PermissionOptionData,
  PlanData,
  ToolCallData,
} from "@vibe-center/shared";
import type * as acp from "../acp/protocol.ts";
import type { PermissionOutcome, TurnResult } from "../acp/runtime.ts";
import type { Repos } from "../db/repos/index.ts";
import type { NewMessage } from "../db/repos/messages.ts";
import type { EventBus } from "../events/bus.ts";

export interface TurnContext {
  turnId: string;
  agentId: string;
  conversationId: string;
  sessionId: string;
  /** Raw ACP updates of this turn, in order (voice worker: sentence splitting, filler cues). */
  onUpdate?: (update: acp.SessionUpdate) => void;
  /** Message kind for the agent's reply text: `voice_transcript` while in a call. */
  replyKind?: "text" | "voice_transcript";
}

/**
 * Turns one turn's runtime events into persisted messages and live events:
 * - text and thought chunks stream into a message; a tool call or permission request ends the
 *   segment, so text around tool calls never glues together ("On it.Done")
 * - each tool call is one message, updated in place
 * - a permission request is a `pending` message until it is answered or the turn ends
 * - the turn's plan is one message, replaced on every update
 */
export class TurnRecorder {
  private segment: { id: string; kind: "text" | "voice_transcript" | "thought"; length: number } | null =
    null;
  private tools = new Map<string, string>();
  private plan: string | null = null;
  private permissions = new Map<string, string>();
  private replyIds: string[] = [];

  constructor(
    private readonly repos: Repos,
    private readonly bus: EventBus,
    readonly ctx: TurnContext,
    private readonly onUnread: (conversationId: string) => void,
  ) {}

  update(u: acp.SessionUpdate): void {
    try {
      this.ctx.onUpdate?.(u);
    } catch (e) {
      console.error("turn observer failed", e);
    }
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const text = contentText(u.content);
        const kind = u.sessionUpdate === "agent_message_chunk" ? (this.ctx.replyKind ?? "text") : "thought";
        if (text) this.appendSegment(kind, text);
        return;
      }
      case "tool_call":
      case "tool_call_update":
        this.closeSegment("complete");
        this.upsertTool(u);
        return;
      case "plan": {
        const data: PlanData = {
          entries: u.entries.map((e) => ({ content: e.content, priority: e.priority, status: e.status })),
        };
        const text = data.entries.map((e) => `- [${e.status}] ${e.content}`).join("\n");
        if (this.plan) this.updateMessage(this.plan, { text, data });
        else this.plan = this.insert({ kind: "plan", role: "agent", status: "complete", text, data }).id;
        return;
      }
      default:
        // usage_update, user_message_chunk, ...: nothing to persist
        return;
    }
  }

  permissionRequest(requestId: string, req: acp.RequestPermissionRequest): Message {
    this.closeSegment("complete");
    const tc = req.toolCall;
    const data: PermissionData = {
      requestId,
      toolCallId: tc.toolCallId,
      title: tc.title ?? "Permission requested",
      toolKind: tc.kind ?? null,
      rawInput: tc.rawInput,
      options: req.options.map(
        (o): PermissionOptionData => ({ optionId: o.optionId, name: o.name, kind: o.kind }),
      ),
      outcome: null,
    };
    const m = this.insert({ kind: "permission", role: "agent", status: "pending", text: data.title, data });
    this.permissions.set(requestId, m.id);
    this.onUnread(this.ctx.conversationId);
    return m;
  }

  permissionResolved(requestId: string, outcome: PermissionOutcome): void {
    const id = this.permissions.get(requestId);
    const m = id ? this.repos.messages.get(id) : null;
    if (m?.kind !== "permission") return;
    this.updateMessage(m.id, {
      status: outcome === "cancelled" ? "cancelled" : "complete",
      data: { ...m.data, outcome },
    });
  }

  /** Finalise the turn's messages. Returns the reply text (all text segments joined). */
  end(result: TurnResult): string {
    this.closeSegment(result.status === "cancelled" ? "cancelled" : "complete");
    if (result.error) {
      this.insert({
        kind: "error",
        role: "system",
        status: "complete",
        text: result.error,
        // A turn-level error is always a harness problem (crash, timeout, missing auth, bad
        // command): point at the setting that's most likely to fix it.
        data: { stopReason: result.stopReason, hint: "settings:harnesses" },
      });
      this.onUnread(this.ctx.conversationId);
    }
    return this.replyIds
      .map((id) => this.repos.messages.get(id)?.text ?? "")
      .filter(Boolean)
      .join("\n\n");
  }

  // ---- internals ------------------------------------------------------------------------------

  private appendSegment(kind: "text" | "voice_transcript" | "thought", text: string): void {
    const seg = this.segment;
    if (seg && seg.kind === kind) {
      this.repos.messages.appendText(seg.id, text);
      this.bus.publish({
        type: "message.delta",
        conversationId: this.ctx.conversationId,
        messageId: seg.id,
        offset: seg.length,
        text,
      });
      seg.length += text.length;
      return;
    }
    this.closeSegment("complete");
    const m = this.insert({ kind, role: "agent", status: "streaming", text });
    this.segment = { id: m.id, kind, length: text.length };
    if (kind !== "thought") {
      this.replyIds.push(m.id);
      this.onUnread(this.ctx.conversationId);
    }
  }

  private closeSegment(status: MessageStatus): void {
    if (!this.segment) return;
    this.updateMessage(this.segment.id, { status });
    this.segment = null;
  }

  private upsertTool(u: acp.ToolCall | acp.ToolCallUpdate): void {
    const existingId = this.tools.get(u.toolCallId);
    const existing = existingId ? this.repos.messages.get(existingId) : null;
    const prev: ToolCallData | null = existing?.kind === "tool_call" ? existing.data : null;
    const data: ToolCallData = {
      ...prev, // keeps fields others attach, e.g. the MCP gateway's `gateway`
      toolCallId: u.toolCallId,
      title: u.title ?? prev?.title ?? "Tool call",
      toolKind: u.kind ?? prev?.toolKind ?? null,
      toolStatus: u.status ?? prev?.toolStatus ?? "pending",
      rawInput: u.rawInput !== undefined ? u.rawInput : prev?.rawInput,
      rawOutput: u.rawOutput !== undefined ? u.rawOutput : prev?.rawOutput,
      content: u.content ? u.content.map(toolContentText).filter(Boolean) : (prev?.content ?? []),
      locations: u.locations
        ? u.locations.map((l) => ({ path: l.path, line: l.line ?? null }))
        : (prev?.locations ?? []),
    };
    if (existingId) {
      this.updateMessage(existingId, { text: data.title, data });
      return;
    }
    const m = this.insert({ kind: "tool_call", role: "agent", status: "complete", text: data.title, data });
    this.tools.set(u.toolCallId, m.id);
  }

  private insert(m: Omit<NewMessage, "conversationId" | "sessionId" | "turnId">): Message {
    const message = this.repos.messages.insert({
      ...m,
      conversationId: this.ctx.conversationId,
      sessionId: this.ctx.sessionId,
      turnId: this.ctx.turnId,
    });
    this.bus.publish({ type: "message.upsert", message });
    return message;
  }

  private updateMessage(id: string, patch: { text?: string; status?: MessageStatus; data?: unknown }): void {
    const message = this.repos.messages.update(id, patch);
    if (message) this.bus.publish({ type: "message.upsert", message });
  }
}

function contentText(c: acp.ContentBlock): string {
  switch (c.type) {
    case "text":
      return c.text;
    case "resource_link":
      return `[${c.name}](${c.uri})`;
    default:
      return "";
  }
}

function toolContentText(c: acp.ToolCallContent): string {
  switch (c.type) {
    case "content":
      return contentText(c.content);
    case "diff":
      return `diff ${c.path}\n${c.newText}`;
    case "terminal":
      return `terminal ${c.terminalId}`;
    default:
      return "";
  }
}
