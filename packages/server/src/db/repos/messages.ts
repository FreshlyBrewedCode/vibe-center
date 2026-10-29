import type { Message, MessageKind, MessageRole, MessageSearchHit, MessageStatus } from "@vibe-center/shared";
import { type Db, json, newId } from "../index.ts";

interface Row {
  seq: number;
  id: string;
  conversation_id: string;
  session_id: string;
  turn_id: string | null;
  role: MessageRole;
  kind: MessageKind;
  status: MessageStatus;
  text: string;
  data: string | null;
  created_at: number;
  updated_at: number;
}

function toMessage(r: Row): Message {
  return {
    seq: r.seq,
    id: r.id,
    conversationId: r.conversation_id,
    sessionId: r.session_id,
    turnId: r.turn_id,
    role: r.role,
    kind: r.kind,
    status: r.status,
    text: r.text,
    data: json.parse(r.data, null),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  } as Message;
}

export interface NewMessage {
  conversationId: string;
  sessionId: string;
  turnId: string | null;
  role: MessageRole;
  kind: MessageKind;
  status: MessageStatus;
  text: string;
  data?: unknown;
}

/** Kinds that count towards a conversation's unread badge. */
const UNREAD_KINDS = "('text', 'permission', 'error', 'voice_transcript')";

export class MessageRepo {
  constructor(private readonly db: Db) {}

  insert(m: NewMessage): Message {
    const id = newId();
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO messages (id, conversation_id, session_id, turn_id, role, kind, status, text, data,
                               created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        m.conversationId,
        m.sessionId,
        m.turnId,
        m.role,
        m.kind,
        m.status,
        m.text,
        m.data === undefined ? null : json.str(m.data),
        now,
        now,
      );
    return this.get(id)!;
  }

  get(id: string): Message | null {
    const r = this.db.query<Row, [string]>("SELECT * FROM messages WHERE id = ?").get(id);
    return r ? toMessage(r) : null;
  }

  update(id: string, patch: { text?: string; status?: MessageStatus; data?: unknown }): Message | null {
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    if (patch.text !== undefined) {
      sets.push("text = ?");
      args.push(patch.text);
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      args.push(patch.status);
    }
    if (patch.data !== undefined) {
      sets.push("data = ?");
      args.push(json.str(patch.data));
    }
    sets.push("updated_at = ?");
    args.push(Date.now(), id);
    this.db.query(`UPDATE messages SET ${sets.join(", ")} WHERE id = ?`).run(...args);
    return this.get(id);
  }

  appendText(id: string, delta: string): void {
    this.db
      .query("UPDATE messages SET text = text || ?, updated_at = ? WHERE id = ?")
      .run(delta, Date.now(), id);
  }

  /** Newest `limit` messages before `before` (exclusive), returned oldest first. */
  list(
    conversationId: string,
    opts: { before?: number; limit: number },
  ): { messages: Message[]; hasMore: boolean } {
    const rows = this.db
      .query<Row, [string, number, number]>(
        "SELECT * FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
      )
      .all(conversationId, opts.before ?? Number.MAX_SAFE_INTEGER, opts.limit + 1);
    const hasMore = rows.length > opts.limit;
    return { messages: rows.slice(0, opts.limit).reverse().map(toMessage), hasMore };
  }

  byTurn(turnId: string): Message[] {
    return this.db
      .query<Row, [string]>("SELECT * FROM messages WHERE turn_id = ? ORDER BY seq")
      .all(turnId)
      .map(toMessage);
  }

  latestSeq(conversationId: string): number {
    return (
      this.db
        .query<{ s: number | null }, [string]>("SELECT max(seq) AS s FROM messages WHERE conversation_id = ?")
        .get(conversationId)?.s ?? 0
    );
  }

  unreadCount(conversationId: string, lastReadSeq: number): number {
    return (
      this.db
        .query<{ n: number }, [string, number]>(
          `SELECT count(*) AS n FROM messages
           WHERE conversation_id = ? AND seq > ? AND role != 'user' AND kind IN ${UNREAD_KINDS}`,
        )
        .get(conversationId, lastReadSeq)?.n ?? 0
    );
  }

  /** Full-text search. `q` is matched as a prefix query over its words. */
  search(q: string, opts: { agentId?: string; limit: number }): MessageSearchHit[] {
    const match = q
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `"${w.replaceAll('"', '""')}"*`)
      .join(" ");
    if (!match) return [];
    const rows = this.db
      .query<Row & { agent_id: string; snippet: string }, [string, string | null, string | null, number]>(
        `SELECT m.*, c.agent_id AS agent_id,
                snippet(messages_fts, 0, '<mark>', '</mark>', '…', 12) AS snippet
         FROM messages_fts
         JOIN messages m ON m.seq = messages_fts.rowid
         JOIN conversations c ON c.id = m.conversation_id
         WHERE messages_fts MATCH ? AND (? IS NULL OR c.agent_id = ?)
         ORDER BY rank LIMIT ?`,
      )
      .all(match, opts.agentId ?? null, opts.agentId ?? null, opts.limit);
    return rows.map((r) => ({ message: toMessage(r), agentId: r.agent_id, snippet: r.snippet }));
  }

  /** On startup: anything still streaming/pending belongs to a turn that died with the server. */
  closeStale(): void {
    const now = Date.now();
    this.db
      .query("UPDATE messages SET status = 'cancelled', updated_at = ? WHERE status = 'streaming'")
      .run(now);
    const pending = this.db
      .query<Row, []>("SELECT * FROM messages WHERE status = 'pending' AND kind = 'permission'")
      .all();
    for (const r of pending) {
      const data = { ...json.parse<Record<string, unknown>>(r.data, {}), outcome: "cancelled" };
      this.db
        .query("UPDATE messages SET status = 'cancelled', data = ?, updated_at = ? WHERE seq = ?")
        .run(json.str(data), now, r.seq);
    }
  }
}
