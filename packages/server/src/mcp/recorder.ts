import type { GatewayCallInfo, Message, ToolCallData } from "@vibe-center/shared";
import type { Repos } from "../db/repos/index.ts";
import type { ToolCallRecord } from "../db/repos/mcp-servers.ts";
import type { EventBus } from "../events/bus.ts";

type ToolMessage = Extract<Message, { kind: "tool_call" }>;

interface PendingCall {
  callId: string;
  exposedName: string;
  /** The harness's id for the tool use, if it sent one (Claude Code: `_meta["claudecode/toolUseId"]`). */
  toolUseId: string | null;
  args: unknown;
  finished: boolean;
}

/** How long a finished call may stay unmatched before it gets a card of its own. */
const FALLBACK_MS = 1500;

/**
 * Shows gateway calls in the DM. Every call is logged (`mcp_tool_calls`); the harness usually
 * reports the same call as an ACP tool_call, and the recorder attaches the gateway's view (server,
 * tool, arguments, result) to that message as `data.gateway`. Matching: the harness's tool-use id
 * when it sends one, else the exposed tool name in the title or identical arguments. Harnesses may
 * announce a call after running it, so unmatched calls wait for new tool_call messages of their
 * turn; a call still unmatched shortly after it finished is shown as its own tool_call message.
 */
export class CallRecorder {
  private pending = new Map<string, PendingCall[]>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly repos: Repos,
    private readonly bus: EventBus,
  ) {
    this.unsubscribe = bus.subscribe((e) => {
      if (e.type !== "message.upsert" || e.message.kind !== "tool_call" || e.message.data.gateway) return;
      if (e.message.turnId && this.pending.has(e.message.turnId)) this.link(e.message.turnId);
    });
  }

  started(rec: ToolCallRecord, hints: { exposedName: string; toolUseId: string | null }): void {
    if (!rec.turnId) return;
    const list = this.pending.get(rec.turnId) ?? [];
    list.push({ callId: rec.callId, ...hints, args: rec.args, finished: false });
    this.pending.set(rec.turnId, list);
    this.link(rec.turnId);
  }

  finished(rec: ToolCallRecord): void {
    if (rec.messageId) {
      this.annotate(rec.messageId, rec);
      return;
    }
    const p = rec.turnId ? this.pending.get(rec.turnId)?.find((c) => c.callId === rec.callId) : null;
    if (!p || !rec.turnId) return;
    p.finished = true;
    const turnId = rec.turnId;
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.fallback(turnId, rec.callId);
    }, FALLBACK_MS);
    this.timers.add(t);
  }

  dispose(): void {
    this.unsubscribe();
    for (const t of this.timers) clearTimeout(t);
  }

  private link(turnId: string): void {
    const calls = this.pending.get(turnId);
    if (!calls?.length) return;
    const free = this.repos.messages
      .byTurn(turnId)
      .filter((m): m is ToolMessage => m.kind === "tool_call" && !m.data.gateway);
    for (const call of [...calls]) {
      const i = free.findIndex((m) => matches(m.data, call));
      if (i < 0) continue;
      const [m] = free.splice(i, 1);
      this.repos.toolCalls.setMessage(call.callId, m!.id);
      this.drop(turnId, call.callId);
      const rec = this.repos.toolCalls.get(call.callId);
      if (rec) this.annotate(m!.id, rec);
    }
  }

  private annotate(messageId: string, rec: ToolCallRecord): void {
    const m = this.repos.messages.get(messageId);
    if (m?.kind !== "tool_call") return;
    const message = this.repos.messages.update(m.id, { data: { ...m.data, gateway: info(rec) } });
    if (message) this.bus.publish({ type: "message.upsert", message });
  }

  private fallback(turnId: string, callId: string): void {
    const rec = this.repos.toolCalls.get(callId);
    if (!rec || rec.messageId || !rec.sessionId) return;
    this.drop(turnId, callId);
    const session = this.repos.conversations.session(rec.sessionId);
    if (!session) return;
    const title = `${rec.server} · ${rec.tool}`;
    const data: ToolCallData = {
      toolCallId: `gateway:${rec.callId}`,
      title,
      toolKind: "other",
      toolStatus: rec.status === "running" ? "in_progress" : rec.status,
      rawInput: rec.args,
      content: [],
      locations: [],
      gateway: info(rec),
    };
    const message = this.repos.messages.insert({
      conversationId: session.conversationId,
      sessionId: session.id,
      turnId,
      role: "agent",
      kind: "tool_call",
      status: "complete",
      text: title,
      data,
    });
    this.repos.toolCalls.setMessage(callId, message.id);
    this.bus.publish({ type: "message.upsert", message });
  }

  private drop(turnId: string, callId: string): void {
    const rest = (this.pending.get(turnId) ?? []).filter((c) => c.callId !== callId);
    if (rest.length) this.pending.set(turnId, rest);
    else this.pending.delete(turnId);
  }
}

function info(rec: ToolCallRecord): GatewayCallInfo {
  return {
    callId: rec.callId,
    server: rec.server,
    tool: rec.tool,
    args: rec.args,
    result: rec.result,
    isError: rec.isError,
    status: rec.status,
    durationMs: rec.durationMs,
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function stable(v: unknown): string {
  return JSON.stringify(v, (_, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );
}

function matches(d: ToolCallData, call: PendingCall): boolean {
  if (call.toolUseId) return d.toolCallId === call.toolUseId;
  if (norm(d.title).includes(norm(call.exposedName))) return true;
  return d.rawInput !== undefined && stable(d.rawInput) === stable(call.args);
}
