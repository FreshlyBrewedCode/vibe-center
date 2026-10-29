import type { Conversation, Session, TurnSource } from "@vibe-center/shared";
import { type Db, json, newId } from "../index.ts";

interface ConversationRow {
  id: string;
  kind: "dm";
  agent_id: string;
  active_session_id: string | null;
  last_read_seq: number;
  created_at: number;
}

const toConversation = (r: ConversationRow): Conversation => ({
  id: r.id,
  kind: r.kind,
  agentId: r.agent_id,
  activeSessionId: r.active_session_id,
  lastReadSeq: r.last_read_seq,
  createdAt: r.created_at,
});

interface SessionRow {
  id: string;
  conversation_id: string;
  agent_id: string;
  acp_session_id: string | null;
  status: "active" | "ended";
  config_state: string | null;
  started_at: number;
  ended_at: number | null;
}

const toSession = (r: SessionRow): Session => ({
  id: r.id,
  conversationId: r.conversation_id,
  agentId: r.agent_id,
  acpSessionId: r.acp_session_id,
  status: r.status,
  startedAt: r.started_at,
  endedAt: r.ended_at,
});

export class ConversationRepo {
  constructor(private readonly db: Db) {}

  get(id: string): Conversation | null {
    const r = this.db.query<ConversationRow, [string]>("SELECT * FROM conversations WHERE id = ?").get(id);
    return r ? toConversation(r) : null;
  }

  dmFor(agentId: string): Conversation | null {
    const r = this.db
      .query<ConversationRow, [string]>("SELECT * FROM conversations WHERE agent_id = ? AND kind = 'dm'")
      .get(agentId);
    return r ? toConversation(r) : null;
  }

  createDm(agentId: string): Conversation {
    const id = newId();
    this.db
      .query("INSERT INTO conversations (id, kind, agent_id, created_at) VALUES (?, 'dm', ?, ?)")
      .run(id, agentId, Date.now());
    return this.get(id)!;
  }

  setActiveSession(id: string, sessionId: string | null): void {
    this.db.query("UPDATE conversations SET active_session_id = ? WHERE id = ?").run(sessionId, id);
  }

  /** Only moves forward; returns the stored value. */
  markRead(id: string, seq: number): number {
    this.db.query("UPDATE conversations SET last_read_seq = max(last_read_seq, ?) WHERE id = ?").run(seq, id);
    return this.get(id)?.lastReadSeq ?? 0;
  }

  // ---- sessions ----

  createSession(conversationId: string, agentId: string): Session {
    const id = newId();
    this.db
      .query("INSERT INTO sessions (id, conversation_id, agent_id, started_at) VALUES (?, ?, ?, ?)")
      .run(id, conversationId, agentId, Date.now());
    this.setActiveSession(conversationId, id);
    return this.session(id)!;
  }

  session(id: string): Session | null {
    const r = this.db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(id);
    return r ? toSession(r) : null;
  }

  sessions(conversationId: string): Session[] {
    return this.db
      .query<SessionRow, [string]>("SELECT * FROM sessions WHERE conversation_id = ? ORDER BY started_at")
      .all(conversationId)
      .map(toSession);
  }

  endSession(id: string): void {
    this.db
      .query("UPDATE sessions SET status = 'ended', ended_at = ? WHERE id = ? AND status = 'active'")
      .run(Date.now(), id);
  }

  setAcpSessionId(id: string, acpSessionId: string): void {
    this.db.query("UPDATE sessions SET acp_session_id = ? WHERE id = ?").run(acpSessionId, id);
  }

  setConfigState(id: string, state: unknown): void {
    this.db.query("UPDATE sessions SET config_state = ? WHERE id = ?").run(json.str(state), id);
  }

  // ---- turns ----

  createTurn(sessionId: string, source: TurnSource, fromAgentId: string | null = null): string {
    const id = newId();
    this.db
      .query("INSERT INTO turns (id, session_id, source, from_agent_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, sessionId, source, fromAgentId, Date.now());
    return id;
  }

  startTurn(id: string): void {
    this.db.query("UPDATE turns SET status = 'running', started_at = ? WHERE id = ?").run(Date.now(), id);
  }

  endTurn(
    id: string,
    status: "complete" | "cancelled" | "error",
    stopReason: string | null,
    error: string | null,
  ): void {
    this.db
      .query("UPDATE turns SET status = ?, stop_reason = ?, error = ?, ended_at = ? WHERE id = ?")
      .run(status, stopReason, error, Date.now(), id);
  }

  /** On startup: turns that were running when the server stopped can't continue. */
  interruptOpenTurns(): number {
    return this.db
      .query("UPDATE turns SET status = 'interrupted', ended_at = ? WHERE status IN ('queued', 'running')")
      .run(Date.now()).changes;
  }
}
