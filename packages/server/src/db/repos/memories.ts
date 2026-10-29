import type { Memory } from "@vibe-center/shared";
import { type Db, json, newId } from "../index.ts";

interface Row {
  seq: number;
  id: string;
  agent_id: string | null;
  content: string;
  tags: string;
  created_at: number;
  updated_at: number;
}

const toMemory = (r: Row): Memory => ({
  id: r.id,
  agentId: r.agent_id,
  content: r.content,
  tags: json.parse(r.tags, []),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/**
 * Which memories a query covers: one agent's own, the shared ones, both (`visibleTo`, what an
 * agent can see), or everything (the UI).
 */
export type MemoryScope =
  | { kind: "agent"; agentId: string }
  | { kind: "shared" }
  | { kind: "visibleTo"; agentId: string }
  | { kind: "all" };

function scopeSql(scope: MemoryScope): { where: string; args: string[] } {
  switch (scope.kind) {
    case "agent":
      return { where: "m.agent_id = ?", args: [scope.agentId] };
    case "shared":
      return { where: "m.agent_id IS NULL", args: [] };
    case "visibleTo":
      return { where: "(m.agent_id = ? OR m.agent_id IS NULL)", args: [scope.agentId] };
    case "all":
      return { where: "1 = 1", args: [] };
  }
}

/** FTS5 prefix query over the words of `q`; any word may match (ranked by bm25). */
export function ftsQuery(q: string, op: "AND" | "OR" = "OR"): string {
  return q
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}_-]/gu, ""))
    .filter(Boolean)
    .map((w) => `"${w}"*`)
    .join(` ${op} `);
}

export class MemoryRepo {
  constructor(private readonly db: Db) {}

  insert(m: { agentId: string | null; content: string; tags: string[] }): Memory {
    const id = newId();
    const now = Date.now();
    this.db
      .query(
        "INSERT INTO memories (id, agent_id, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, m.agentId, m.content, json.str(m.tags), now, now);
    return this.get(id)!;
  }

  get(id: string): Memory | null {
    const r = this.db.query<Row, [string]>("SELECT * FROM memories WHERE id = ?").get(id);
    return r ? toMemory(r) : null;
  }

  update(id: string, patch: { content?: string; tags?: string[]; agentId?: string | null }): Memory | null {
    const cur = this.get(id);
    if (!cur) return null;
    const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    this.db
      .query("UPDATE memories SET content = ?, tags = ?, agent_id = ?, updated_at = ? WHERE id = ?")
      .run(next.content, json.str(next.tags), next.agentId, Date.now(), id);
    return this.get(id);
  }

  delete(id: string): void {
    this.db.query("DELETE FROM memories WHERE id = ?").run(id);
  }

  /** Newest first. */
  list(scope: MemoryScope, opts: { limit: number; offset?: number; tag?: string }): Memory[] {
    const s = scopeSql(scope);
    const tagWhere = opts.tag ? "AND EXISTS (SELECT 1 FROM json_each(m.tags) WHERE value = ?)" : "";
    return this.db
      .query<Row, (string | number)[]>(
        `SELECT m.* FROM memories m WHERE ${s.where} ${tagWhere}
         ORDER BY m.updated_at DESC, m.seq DESC LIMIT ? OFFSET ?`,
      )
      .all(...s.args, ...(opts.tag ? [opts.tag] : []), opts.limit, opts.offset ?? 0)
      .map(toMemory);
  }

  /** Full-text search, best match first. Tags are searched too. */
  search(q: string, scope: MemoryScope, limit: number): Memory[] {
    const match = ftsQuery(q);
    if (!match) return [];
    const s = scopeSql(scope);
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = this.db
      .query<Row, (string | number)[]>(
        `SELECT m.* FROM memories_fts JOIN memories m ON m.seq = memories_fts.rowid
         WHERE memories_fts MATCH ? AND ${s.where}
         ORDER BY rank LIMIT ?`,
      )
      .all(match, ...s.args, limit);
    // Memories whose tags match a query word, even if the content doesn't.
    const seen = new Set(rows.map((r) => r.id));
    if (words.length && rows.length < limit) {
      const tagged = this.db
        .query<Row, (string | number)[]>(
          `SELECT m.* FROM memories m WHERE ${s.where}
           AND EXISTS (SELECT 1 FROM json_each(m.tags) WHERE lower(value) IN (${words.map(() => "?").join(",")}))
           ORDER BY m.updated_at DESC LIMIT ?`,
        )
        .all(...s.args, ...words, limit);
      for (const r of tagged) if (!seen.has(r.id) && rows.length < limit) rows.push(r);
    }
    return rows.map(toMemory);
  }
}
