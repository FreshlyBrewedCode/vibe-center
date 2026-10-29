import type { MessageKind, MessageRole, TurnSource } from "@vibe-center/shared";
import type { Db } from "../index.ts";
import { ftsQuery } from "./memories.ts";

/** A message as the conversation-search tools return it: who said it, where, when. */
export interface FoundMessage {
  id: string;
  seq: number;
  agentId: string;
  conversationId: string;
  role: MessageRole;
  kind: MessageKind;
  text: string;
  source: TurnSource | null;
  fromAgentId: string | null;
  createdAt: number;
  snippet?: string;
}

interface Row {
  id: string;
  seq: number;
  agent_id: string;
  conversation_id: string;
  role: MessageRole;
  kind: MessageKind;
  text: string;
  source: TurnSource | null;
  from_agent_id: string | null;
  created_at: number;
  snippet?: string;
}

const toFound = (r: Row): FoundMessage => ({
  id: r.id,
  seq: r.seq,
  agentId: r.agent_id,
  conversationId: r.conversation_id,
  role: r.role,
  kind: r.kind,
  text: r.text,
  source: r.source,
  fromAgentId: r.from_agent_id,
  createdAt: r.created_at,
  ...(r.snippet !== undefined ? { snippet: r.snippet } : {}),
});

/** Conversation text only: what was said, not tool calls, thoughts or markers. */
const SAID = "m.kind IN ('text', 'voice_transcript')";
const COLUMNS = `m.id, m.seq, c.agent_id, m.conversation_id, m.role, m.kind, m.text, m.created_at,
                 t.source, t.from_agent_id`;
const JOINS = "JOIN conversations c ON c.id = m.conversation_id LEFT JOIN turns t ON t.id = m.turn_id";
const FROM = `messages m ${JOINS}`;

export interface MessageSearchFilter {
  agentId?: string;
  role?: "user" | "agent";
  since?: number;
  until?: number;
  /** Leave out messages of this turn (the search request itself). */
  excludeTurnId?: string | null;
  limit: number;
}

/** Search over the phase 1 FTS index with filters, and the messages around a hit (phase 2a tools). */
export class MessageSearchRepo {
  constructor(private readonly db: Db) {}

  search(q: string, f: MessageSearchFilter): FoundMessage[] {
    const match = ftsQuery(q);
    if (!match) return [];
    const where = [SAID, "messages_fts MATCH ?"];
    const args: (string | number)[] = [match];
    if (f.agentId) {
      where.push("c.agent_id = ?");
      args.push(f.agentId);
    }
    if (f.role) {
      where.push("m.role = ?");
      args.push(f.role);
    }
    if (f.since) {
      where.push("m.created_at >= ?");
      args.push(f.since);
    }
    if (f.until) {
      where.push("m.created_at <= ?");
      args.push(f.until);
    }
    if (f.excludeTurnId) {
      where.push("(m.turn_id IS NULL OR m.turn_id != ?)");
      args.push(f.excludeTurnId);
    }
    return this.db
      .query<Row, (string | number)[]>(
        `SELECT ${COLUMNS}, snippet(messages_fts, 0, '«', '»', '…', 24) AS snippet
         FROM messages_fts JOIN messages m ON m.seq = messages_fts.rowid ${JOINS}
         WHERE ${where.join(" AND ")}
         ORDER BY rank LIMIT ?`,
      )
      .all(...args, f.limit)
      .map(toFound);
  }

  get(id: string): FoundMessage | null {
    const r = this.db.query<Row, [string]>(`SELECT ${COLUMNS} FROM ${FROM} WHERE m.id = ?`).get(id);
    return r ? toFound(r) : null;
  }

  /** `before` messages before and `after` after the given one, in the same conversation, in order. */
  around(hit: FoundMessage, before: number, after: number): FoundMessage[] {
    const older = this.db
      .query<Row, [string, number, number]>(
        `SELECT ${COLUMNS} FROM ${FROM} WHERE m.conversation_id = ? AND m.seq < ? AND ${SAID}
         ORDER BY m.seq DESC LIMIT ?`,
      )
      .all(hit.conversationId, hit.seq, before)
      .reverse();
    const newer = this.db
      .query<Row, [string, number, number]>(
        `SELECT ${COLUMNS} FROM ${FROM} WHERE m.conversation_id = ? AND m.seq > ? AND ${SAID}
         ORDER BY m.seq ASC LIMIT ?`,
      )
      .all(hit.conversationId, hit.seq, after);
    return [...older.map(toFound), hit, ...newer.map(toFound)];
  }
}
