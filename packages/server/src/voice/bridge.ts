import type { CallState, CallTurnLatency, CallWaiting, ServerEvent } from "@vibe-center/shared";
import type { ServerWebSocket } from "bun";
import type * as acp from "../acp/protocol.ts";
import type { ChatService, PromptHandle } from "../domain/chat.ts";
import type { EventBus } from "../events/bus.ts";

/**
 * The app side of the worker's bridge (protocol in services/voice/voice_worker/bridge.py): one
 * WebSocket per call, authenticated by the call's own Bearer credential. The worker's "LLM step"
 * arrives here as `prompt` frames, goes into the agent's existing session through
 * `ChatService.prompt` (source "voice", transcripts on both sides, the voice-mode note, a short
 * idle timeout), and the reply streams back as `text`/`tool` frames. `cancel` (barge-in while the
 * turn is still running) cancels only that turn; `interrupted` (barge-in while a finished reply is
 * still being spoken) marks its reply message instead, since there is nothing left to cancel.
 *
 * A prompt shares the agent's queue with text, agent and event turns. When it is stuck behind
 * one (waiting for an approval in the chat, or just busy), the worker gets a `waiting` frame so
 * it can say so instead of going quiet until its timeout, and the call shows it (`call.waiting`).
 */
export interface BridgeSocketData {
  bridgeCallId: string;
}

export type WorkerFrame =
  | { type: "prompt"; id: string; text: string; kind?: "user" | "event"; context?: string }
  | { type: "cancel"; id: string }
  | { type: "interrupted"; id: string }
  | { type: "state"; state: Exclude<CallState, "connecting" | "ended"> }
  | ({ type: "latency" } & CallTurnLatency);

export type AppFrame =
  | { type: "hello"; callId: string; agentName: string }
  | { type: "started"; id: string; turnId: string }
  | { type: "usage"; id: string }
  | { type: "text"; id: string; text: string }
  | { type: "tool"; id: string; toolCallId: string; title: string; status: "start" | "end" }
  | { type: "permission"; id: string; title: string }
  /** The prompt is queued behind other work: a turn waiting for approval, or just a busy agent. */
  | { type: "waiting"; id: string; reason: CallWaiting["reason"]; title: string | null }
  | { type: "done"; id: string; status: "complete" | "cancelled" | "error"; error?: string | null }
  | { type: "event"; text: string }
  | { type: "end"; reason: string };

/** No ACP update for this long ends a voice turn with an error (the worker apologises). */
export const VOICE_IDLE_MS = 20_000;
/** A prompt queued behind a busy (not blocked) agent this long gets a `waiting` frame. */
export const BUSY_NOTICE_MS = 2500;

/** Sent before every call prompt (hidden; not stored). The fake test agent strips this block. */
export function voiceNote(kind: "user" | "event", context?: string): string {
  const lines = [
    "<voice-call>",
    "You are on a live voice call with the user. Everything you write is converted to speech.",
    "- Reply in 1 to 3 short spoken sentences of plain conversational English: no markdown, lists, headings, code or emoji.",
    '- Before you call a tool, first say one brief sentence such as "Let me check." Then give the result in a sentence or two.',
    kind === "user"
      ? "- The user's words come from speech recognition and may contain small errors; guess the intent."
      : "- This message is a notification for the user, not something they said. Tell them about it in one short sentence.",
  ];
  if (context) lines.push(`- Context: ${context}`);
  lines.push("</voice-call>");
  return lines.join("\n");
}

/** Extra for a proactive event: hidden context for the agent, the sender, the turn once prompted. */
export interface SpokenEvent {
  note?: string;
  fromAgentId?: string | null;
  onPrompt?: (handle: PromptHandle) => void;
}

export interface CallBridgeHandlers {
  onState(state: CallState): void;
  onLatency(turn: CallTurnLatency): void;
  onWaiting(waiting: CallWaiting | null): void;
  onClose(reason: string): void;
}

interface OpenPrompt {
  turnId: string | null;
  usageSent: boolean;
  cancelled: boolean;
  queuedAt: number;
  /** The `waiting` reason the worker was last told, so it hears each one once. */
  told: CallWaiting["reason"] | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export class CallBridge {
  private ws: ServerWebSocket<BridgeSocketData> | null = null;
  private prompts = new Map<string, OpenPrompt>();
  /** Turn id of a prompt that already resolved, kept around for a late "interrupted" frame (the
   * worker only knows a reply was barged into once the bot stops speaking, after the turn ended). */
  private resolvedTurns = new Map<string, string>();
  /** Events handed to the worker, waiting for it to prompt them (it does, in order). */
  private events: { text: string; opts: SpokenEvent }[] = [];
  private closed = false;
  private unsubscribe: () => void;

  constructor(
    readonly callId: string,
    readonly agentId: string,
    private readonly agentName: string,
    private readonly chat: ChatService,
    bus: EventBus,
    private readonly handlers: CallBridgeHandlers,
  ) {
    // Permission requests aren't session updates; spot them as messages of our turns.
    this.unsubscribe = bus.subscribe((e) => this.onBusEvent(e));
  }

  get connected(): boolean {
    return this.ws !== null && !this.closed;
  }

  attach(ws: ServerWebSocket<BridgeSocketData>): void {
    this.ws = ws;
    this.send({ type: "hello", callId: this.callId, agentName: this.agentName });
  }

  handle(raw: string | Buffer): void {
    let frame: WorkerFrame;
    try {
      frame = JSON.parse(String(raw)) as WorkerFrame;
    } catch {
      return;
    }
    switch (frame.type) {
      case "prompt":
        this.prompt(frame);
        return;
      case "cancel":
        this.cancel(frame.id);
        return;
      case "interrupted":
        this.interrupted(frame.id);
        return;
      case "state":
        this.handlers.onState(frame.state);
        return;
      case "latency": {
        const { type: _, ...turn } = frame;
        this.handlers.onLatency(turn);
        return;
      }
    }
  }

  /** Proactive event: the worker speaks it when the user and the agent are quiet. */
  sendEvent(text: string, opts: SpokenEvent = {}): boolean {
    if (!this.connected) return false;
    this.events.push({ text: text.trim(), opts });
    this.send({ type: "event", text });
    return true;
  }

  /** Hang up from the app side (the worker ends its pipeline). */
  end(reason: string): void {
    this.send({ type: "end", reason });
    this.close(reason);
  }

  /** The socket closed or the call ended: cancel what's still running for this call. */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    for (const id of this.prompts.keys()) this.cancel(id);
    this.resolvedTurns.clear();
    for (const open of this.prompts.values()) if (open.timer) clearTimeout(open.timer);
    try {
      this.ws?.close(1000, reason.slice(0, 100));
    } catch {}
    this.handlers.onClose(reason);
  }

  // ---- turns ---------------------------------------------------------------------------------

  private prompt(f: Extract<WorkerFrame, { type: "prompt" }>): void {
    const kind = f.kind === "event" ? "event" : "user";
    const open: OpenPrompt = {
      turnId: null,
      usageSent: false,
      cancelled: false,
      queuedAt: Date.now(),
      told: null,
      timer: null,
    };
    this.prompts.set(f.id, open);
    let ev: SpokenEvent = {};
    if (kind === "event") {
      const i = this.events.findIndex((e) => e.text === f.text.trim());
      ev = (i >= 0 ? this.events.splice(i, 1)[0]?.opts : undefined) ?? {};
    }
    let handle: PromptHandle;
    try {
      handle = this.chat.prompt(this.agentId, {
        text: f.text,
        source: kind === "event" ? "event" : "voice",
        fromAgentId: ev.fromAgentId ?? null,
        display: kind === "event" ? "text" : "voice_transcript",
        replyKind: "voice_transcript",
        note: [voiceNote(kind, f.context), ev.note].filter(Boolean).join("\n"),
        idleTimeoutMs: VOICE_IDLE_MS,
        onUpdate: (u) => this.forward(f.id, open, u),
        onStart: () => this.refreshWaiting(),
      });
    } catch (e) {
      this.prompts.delete(f.id);
      this.send({ type: "done", id: f.id, status: "error", error: (e as Error).message });
      return;
    }
    open.turnId = handle.turnId;
    ev.onPrompt?.(handle);
    this.send({ type: "started", id: f.id, turnId: handle.turnId });
    if (open.cancelled) this.chat.cancelTurn(this.agentId, handle.turnId);
    this.refreshWaiting();
    open.timer = setTimeout(() => this.refreshWaiting(), BUSY_NOTICE_MS);
    const finish = (frame: AppFrame) => {
      if (open.timer) clearTimeout(open.timer);
      this.prompts.delete(f.id);
      this.send(frame);
      this.refreshWaiting();
    };
    void handle.done.then(
      (r) => {
        if (open.turnId) this.resolvedTurns.set(f.id, open.turnId);
        finish({ type: "done", id: f.id, status: r.status, error: r.error });
      },
      (e) => finish({ type: "done", id: f.id, status: "error", error: String(e) }),
    );
  }

  /**
   * Work out what this call's open prompts wait for, tell the worker about new reasons (an
   * approval at once, a busy agent after BUSY_NOTICE_MS) and report it on the call. A prompt
   * waiting for its own turn's approval already got a `permission` frame; one queued behind this
   * call's own earlier prompt (a barge-in still finishing) isn't stuck on anything else.
   */
  private refreshWaiting(): void {
    if (this.closed) return;
    const own = new Set([...this.prompts.values()].map((p) => p.turnId));
    let waiting: CallWaiting | null = null;
    for (const [id, open] of this.prompts) {
      if (!open.turnId || open.cancelled) continue;
      const w = this.chat.waitState(this.agentId, open.turnId);
      if (!w || (w.blockedBy && own.has(w.blockedBy))) continue;
      const reason = w.permission ? "permission" : "busy";
      waiting ??= { reason, detail: w.permission };
      if (!w.blockedBy || open.told === reason) continue;
      if (reason === "busy" && Date.now() - open.queuedAt < BUSY_NOTICE_MS) continue;
      open.told = reason;
      this.send({ type: "waiting", id, reason, title: w.permission });
    }
    this.handlers.onWaiting(waiting);
  }

  private cancel(id: string): void {
    const open = this.prompts.get(id);
    if (!open || open.cancelled) return;
    open.cancelled = true;
    if (open.turnId) this.chat.cancelTurn(this.agentId, open.turnId);
  }

  /** The reply already finished generating when the barge-in happened: nothing to cancel, just mark it. */
  private interrupted(id: string): void {
    const turnId = this.prompts.get(id)?.turnId ?? this.resolvedTurns.get(id);
    this.resolvedTurns.delete(id);
    if (turnId) this.chat.markInterrupted(turnId);
  }

  private forward(id: string, open: OpenPrompt, u: acp.SessionUpdate): void {
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content.type === "text" && u.content.text)
          this.send({ type: "text", id, text: u.content.text });
        return;
      case "tool_call":
        this.send({
          type: "tool",
          id,
          toolCallId: u.toolCallId,
          title: u.title ?? "Tool call",
          status: "start",
        });
        return;
      case "tool_call_update":
        if (u.status === "completed" || u.status === "failed") {
          this.send({ type: "tool", id, toolCallId: u.toolCallId, title: u.title ?? "", status: "end" });
        }
        return;
      case "usage_update":
        if (!open.usageSent) {
          open.usageSent = true;
          this.send({ type: "usage", id });
        }
        return;
      default:
        return;
    }
  }

  private onBusEvent(e: ServerEvent): void {
    if (e.type !== "message.upsert" || e.message.kind !== "permission") return;
    // any turn of the agent asking or getting an answer can block or unblock ours
    this.refreshWaiting();
    if (e.message.status !== "pending") return;
    for (const [id, open] of this.prompts) {
      if (open.turnId && open.turnId === e.message.turnId) {
        this.send({ type: "permission", id, title: e.message.text });
      }
    }
  }

  private send(frame: AppFrame): void {
    if (!this.ws || this.closed) return;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch {}
  }
}
