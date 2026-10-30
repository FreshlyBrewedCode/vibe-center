import type { Agent, Message, Session, TurnMeta, TurnSource } from "@vibe-center/shared";
import { adapters } from "../acp/adapters/index.ts";
import { toConfigOptions } from "../acp/config-options.ts";
import type { McpProvider } from "../acp/mcp.ts";
import type * as acp from "../acp/protocol.ts";
import {
  AgentRuntime,
  type RuntimeConfig,
  type RuntimeEvent,
  type RuntimeTimeouts,
  type TurnResult,
} from "../acp/runtime.ts";
import { dataPaths, expandHome } from "../config.ts";
import type { Repos } from "../db/repos/index.ts";
import type { EventBus } from "../events/bus.ts";
import type { ProcessTracker } from "../procs.ts";
import { HttpError } from "./errors.ts";
import { type HarnessService, launchConfig } from "./harnesses.ts";
import type { PresenceStore } from "./presence.ts";
import { TurnRecorder } from "./turns.ts";

/**
 * A prompt into an agent's current session, from any source. This is the one entry point for
 * the UI (source "user"), the voice worker (phase 2b, source "voice") and agent-to-agent
 * messages or app events (phase 2a, sources "agent" / "event").
 */
export interface PromptRequest {
  text: string;
  source: TurnSource;
  /** Sending agent, for source "agent". */
  fromAgentId?: string | null;
  /**
   * How the prompt shows in the DM: a `text` message (default), a `voice_transcript` (calls), or
   * not at all (`hidden`, e.g. a warm-up prompt).
   */
  display?: "text" | "voice_transcript" | "hidden";
  /** Kind of the agent's reply messages; calls record both sides as `voice_transcript`. */
  replyKind?: "text" | "voice_transcript";
  /** Hidden instructions sent before the text, e.g. the voice-mode note. Not persisted. */
  note?: string;
  /** Overrides the runtime's idle timeout for this turn (voice turns want it short). */
  idleTimeoutMs?: number;
  /** Raw ACP updates of this turn as they arrive. */
  onUpdate?: (update: acp.SessionUpdate) => void;
}

export interface PromptHandle {
  turnId: string;
  /** The persisted prompt message, unless `display: "hidden"`. */
  message: Message | null;
  /** Resolves when the turn ends, with the agent's reply text (all text segments joined). */
  done: Promise<TurnResult & { text: string }>;
}

export interface ChatOptions {
  dataDir: string;
  mcp: McpProvider;
  timeouts?: Partial<RuntimeTimeouts>;
  tracker?: ProcessTracker;
}

/**
 * Conversations with agents: owns one AgentRuntime per agent (created lazily), persists every
 * turn as messages, and publishes live events. Storage and HTTP stay out of the ACP layer.
 */
export class ChatService {
  private runtimes = new Map<string, AgentRuntime>();
  private turns = new Map<string, TurnRecorder>();
  /** Reply text of ended turns until their PromptHandle.done picks it up. */
  private replies = new Map<string, string>();
  /** Permission message id → where to answer it. */
  private pendingPermissions = new Map<string, { agentId: string; requestId: string }>();
  /** Agents being deleted: they take no prompts, so nothing can spawn their harness again. */
  private retired = new Set<string>();

  constructor(
    private readonly repos: Repos,
    private readonly bus: EventBus,
    private readonly presence: PresenceStore,
    private readonly harnesses: HarnessService,
    private readonly opts: ChatOptions,
  ) {
    // Turns that were running when the server stopped can't continue.
    repos.conversations.interruptOpenTurns();
    repos.messages.closeStale();
  }

  // ---- public API -----------------------------------------------------------------------------

  prompt(agentId: string, req: PromptRequest): PromptHandle {
    const agent = this.requireAgent(agentId);
    const { conversation, session } = this.activeSession(agent.id);
    const turnId = this.repos.conversations.createTurn(session.id, req.source, req.fromAgentId ?? null);
    let message: Message | null = null;
    if (req.display !== "hidden") {
      const data: TurnMeta = { source: req.source, fromAgentId: req.fromAgentId ?? null };
      message = this.repos.messages.insert({
        conversationId: conversation.id,
        sessionId: session.id,
        turnId,
        role: "user",
        kind: req.display ?? "text",
        status: "complete",
        text: req.text,
        data,
      });
      this.bus.publish({ type: "message.upsert", message });
      // Your own message means you've read everything up to it.
      if (req.source === "user") this.markRead(conversation.id, message.seq);
    }
    const recorder = new TurnRecorder(
      this.repos,
      this.bus,
      {
        turnId,
        agentId,
        conversationId: conversation.id,
        sessionId: session.id,
        onUpdate: req.onUpdate,
        replyKind: req.replyKind,
      },
      (id) => this.publishUnread(id),
    );
    this.turns.set(turnId, recorder);
    const { done } = this.runtime(agent).prompt({
      turnId,
      content: [{ type: "text", text: req.text }],
      note: req.note,
      idleTimeoutMs: req.idleTimeoutMs,
    });
    return {
      turnId,
      message,
      // The runtime resolves `done` right after emitting turn.end, so the reply is recorded by now.
      done: done.then((result) => {
        const text = this.replies.get(turnId) ?? "";
        this.replies.delete(turnId);
        return { ...result, text };
      }),
    };
  }

  /** Send from the UI: a user prompt into the conversation's active session. */
  send(conversationId: string, text: string): PromptHandle {
    const conv = this.requireConversation(conversationId);
    return this.prompt(conv.agentId, { text, source: "user" });
  }

  /** Stop the running turn (and drop queued ones). */
  async cancel(conversationId: string): Promise<void> {
    const conv = this.requireConversation(conversationId);
    await this.runtimes.get(conv.agentId)?.cancel();
  }

  /** Start the agent's harness and session now, ahead of its first prompt (calls do this). */
  warm(agentId: string): Promise<void> {
    return this.runtime(this.requireAgent(agentId)).warm();
  }

  /** Cancel one turn (running or queued) of an agent without touching its other turns. */
  cancelTurn(agentId: string, turnId: string): void {
    this.runtimes.get(agentId)?.cancelPrompt(turnId);
  }

  /**
   * A voice reply was barged into after the turn had already finished generating (so there was
   * nothing left to cancel): mark its reply message(s) as interrupted. The DM still shows what
   * the agent wrote; the marker says the user may not have heard all of it.
   */
  markInterrupted(turnId: string): void {
    for (const m of this.repos.messages.byTurn(turnId)) {
      if (m.role !== "agent" || (m.kind !== "text" && m.kind !== "voice_transcript")) continue;
      const message = this.repos.messages.update(m.id, { data: { ...m.data, interrupted: true } });
      if (message) this.bus.publish({ type: "message.upsert", message });
    }
  }

  /** End the active session and start a fresh one; history stays, a divider marks the boundary. */
  async newSession(conversationId: string): Promise<Session> {
    const conv = this.requireConversation(conversationId);
    const rt = this.runtimes.get(conv.agentId);
    await rt?.cancel();
    if (conv.activeSessionId) this.repos.conversations.endSession(conv.activeSessionId);
    const session = this.repos.conversations.createSession(conv.id, conv.agentId);
    await rt?.newSession(session.id);
    this.bus.publish({ type: "session.started", session });
    const marker = this.repos.messages.insert({
      conversationId: conv.id,
      sessionId: session.id,
      turnId: null,
      role: "system",
      kind: "session",
      status: "complete",
      text: "New session",
      data: { reason: "new" },
    });
    this.bus.publish({ type: "message.upsert", message: marker });
    return session;
  }

  respondPermission(messageId: string, optionId: string): void {
    const pending = this.pendingPermissions.get(messageId);
    const m = this.repos.messages.get(messageId);
    if (m?.kind !== "permission") throw new HttpError(404, "permission request not found");
    if (!pending || m.status !== "pending") throw new HttpError(409, "this request was already answered");
    if (!m.data.options.some((o) => o.optionId === optionId)) throw new HttpError(400, "unknown option");
    const ok = this.runtimes.get(pending.agentId)?.respondPermission(pending.requestId, optionId);
    if (!ok) throw new HttpError(409, "the turn that asked has ended");
  }

  markRead(conversationId: string, seq: number): void {
    this.requireConversation(conversationId);
    this.repos.conversations.markRead(conversationId, seq);
    this.publishUnread(conversationId);
  }

  unread(conversationId: string): number {
    const conv = this.repos.conversations.get(conversationId);
    return conv ? this.repos.messages.unreadCount(conv.id, conv.lastReadSeq) : 0;
  }

  /** The agent's config changed: apply it to the live runtime (model/options now, launch on idle). */
  reconfigure(agentId: string): void {
    const rt = this.runtimes.get(agentId);
    const agent = this.repos.agents.get(agentId);
    if (rt && agent) rt.reconfigure(this.runtimeConfig(agent));
  }

  reconfigureHarness(harnessId: string): void {
    for (const agentId of this.runtimes.keys()) {
      if (this.repos.agents.get(agentId)?.harnessId === harnessId) this.reconfigure(agentId);
    }
  }

  /** Stop the agent's runtime: queued and running turns end with `reason`, the harness stops. */
  async disposeAgent(agentId: string, reason?: string): Promise<void> {
    const rt = this.runtimes.get(agentId);
    this.runtimes.delete(agentId);
    await rt?.dispose(reason);
    this.presence.forget(agentId);
  }

  /**
   * The agent is being deleted: from now on it takes no prompts (404), so nothing (another
   * agent's message, a delivered reply, a call) can spawn its harness again. `retired = false`
   * once its row is gone, or if the deletion failed.
   */
  setRetired(agentId: string, retired: boolean): void {
    if (retired) this.retired.add(agentId);
    else this.retired.delete(agentId);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.runtimes.keys()].map((id) => this.disposeAgent(id)));
  }

  /** Harness process ids per agent (diagnostics, tests). */
  pids(): Record<string, number | undefined> {
    return Object.fromEntries([...this.runtimes].map(([id, rt]) => [id, rt.pid]));
  }

  // ---- runtime wiring -------------------------------------------------------------------------

  private runtime(agent: Agent): AgentRuntime {
    const existing = this.runtimes.get(agent.id);
    if (existing) return existing;
    const { session } = this.activeSession(agent.id);
    const rt = new AgentRuntime({
      ...this.runtimeConfig(agent),
      mcp: this.opts.mcp,
      session: { key: session.id, acpSessionId: session.acpSessionId },
      onEvent: (e) => this.onRuntimeEvent(agent.id, e),
      timeouts: this.opts.timeouts,
      tracker: this.opts.tracker,
    });
    this.runtimes.set(agent.id, rt);
    return rt;
  }

  private runtimeConfig(agent: Agent): RuntimeConfig {
    const harness = this.harnesses.get(agent.harnessId);
    if (!harness) throw new HttpError(400, `harness not found: ${agent.harnessId}`, "settings:harnesses");
    return {
      agent: {
        agentId: agent.id,
        cwd: expandHome(agent.cwd),
        systemPrompt: agent.systemPrompt,
        model: agent.model,
        stateDir: dataPaths(this.opts.dataDir).agentState(agent.id),
      },
      options: agent.options,
      harness: launchConfig(harness),
      adapter: adapters[harness.kind],
    };
  }

  private onRuntimeEvent(agentId: string, e: RuntimeEvent): void {
    switch (e.type) {
      case "turn.start":
        this.repos.conversations.startTurn(e.turnId);
        return;
      case "turn.update":
        this.turns.get(e.turnId)?.update(e.update);
        return;
      case "permission.request": {
        const m = this.turns.get(e.turnId)?.permissionRequest(e.requestId, e.request);
        if (m) this.pendingPermissions.set(m.id, { agentId, requestId: e.requestId });
        return;
      }
      case "permission.resolved": {
        this.turns.get(e.turnId)?.permissionResolved(e.requestId, e.outcome);
        for (const [mid, p] of this.pendingPermissions) {
          if (p.requestId === e.requestId) this.pendingPermissions.delete(mid);
        }
        return;
      }
      case "turn.end": {
        const rec = this.turns.get(e.turnId);
        this.turns.delete(e.turnId);
        const text = rec?.end(e.result) ?? "";
        this.repos.conversations.endTurn(e.turnId, e.result.status, e.result.stopReason, e.result.error);
        this.replies.set(e.turnId, text);
        return;
      }
      case "session.ready":
        this.onSessionReady(agentId, e);
        return;
      case "session.update":
        return;
      case "presence":
        this.presence.set(agentId, e.presence, e.detail);
        return;
      case "auth": {
        const harnessId = this.repos.agents.get(agentId)?.harnessId;
        if (harnessId && !e.report.loggedIn) {
          this.harnesses.setHealth(harnessId, {
            status: "auth_required",
            message: `${e.report.label}. Log in with the harness's CLI.`,
            checkedAt: Date.now(),
          });
        }
        return;
      }
      case "process.exit":
        console.warn(
          `harness for agent ${agentId} exited (code ${e.code ?? "?"}${e.signal ? `, ${e.signal}` : ""})`,
        );
        return;
    }
  }

  private onSessionReady(agentId: string, e: Extract<RuntimeEvent, { type: "session.ready" }>): void {
    const session = this.repos.conversations.session(e.sessionKey);
    if (!session) return;
    this.repos.conversations.setAcpSessionId(session.id, e.acpSessionId);
    this.repos.conversations.setConfigState(session.id, { configOptions: e.configOptions });
    const harnessId = this.repos.agents.get(agentId)?.harnessId;
    if (harnessId) this.harnesses.noteConfigOptions(harnessId, toConfigOptions(e.configOptions));
    const notes: { kind: "session" | "error"; text: string; data: unknown }[] = [];
    if (e.resumeFailed) {
      notes.push({
        kind: "session",
        text: `The previous harness session could not be resumed (${e.resumeFailed}), so a new one started.`,
        data: { reason: "resume_failed" },
      });
    }
    if (e.configWarnings.length) {
      notes.push({
        kind: "error",
        text: `Some agent settings were not applied: ${e.configWarnings.join("; ")}`,
        data: null,
      });
    }
    for (const n of notes) {
      const message = this.repos.messages.insert({
        conversationId: session.conversationId,
        sessionId: session.id,
        turnId: null,
        role: "system",
        kind: n.kind,
        status: "complete",
        text: n.text,
        data: n.data,
      });
      this.bus.publish({ type: "message.upsert", message });
    }
  }

  // ---- helpers --------------------------------------------------------------------------------

  private publishUnread(conversationId: string): void {
    const conv = this.repos.conversations.get(conversationId);
    if (!conv) return;
    this.bus.publish({
      type: "conversation.unread",
      conversationId,
      agentId: conv.agentId,
      unread: this.repos.messages.unreadCount(conv.id, conv.lastReadSeq),
      lastReadSeq: conv.lastReadSeq,
    });
  }

  private activeSession(agentId: string) {
    const conversation =
      this.repos.conversations.dmFor(agentId) ?? this.repos.conversations.createDm(agentId);
    const active = conversation.activeSessionId
      ? this.repos.conversations.session(conversation.activeSessionId)
      : null;
    const session =
      active && active.status === "active"
        ? active
        : this.repos.conversations.createSession(conversation.id, agentId);
    return { conversation, session };
  }

  /** The agent, if it exists and isn't being deleted; else a 404. */
  requireAgent(id: string): Agent {
    const a = this.retired.has(id) ? null : this.repos.agents.get(id);
    if (!a) throw new HttpError(404, `agent not found: ${id}`);
    return a;
  }

  private requireConversation(id: string) {
    const c = this.repos.conversations.get(id);
    if (!c) throw new HttpError(404, `conversation not found: ${id}`);
    return c;
  }
}
