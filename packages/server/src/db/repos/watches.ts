import type { Watch, WatchKind, WatchStatus } from "@vibe-center/shared";
import { type Db, json, newId } from "../index.ts";

interface Row {
  id: string;
  agent_id: string;
  kind: WatchKind;
  label: string;
  note: string;
  status: WatchStatus;
  spec: string;
  fire_at: number | null;
  expires_at: number | null;
  repeat: number;
  fire_count: number;
  outcome: string | null;
  secret_hash: string | null;
  depth: number;
  created_at: number;
  updated_at: number;
}

/** A watch plus what only the server needs: the per-kind spec, the webhook secret's hash, the chain depth. */
export interface WatchRecord extends Watch {
  spec: Record<string, unknown>;
  secretHash: string | null;
  depth: number;
}

const toRecord = (r: Row): WatchRecord => ({
  id: r.id,
  agentId: r.agent_id,
  kind: r.kind,
  label: r.label,
  note: r.note,
  status: r.status,
  fireAt: r.fire_at,
  expiresAt: r.expires_at,
  repeat: !!r.repeat,
  fireCount: r.fire_count,
  outcome: r.outcome,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  spec: json.parse(r.spec, {}),
  secretHash: r.secret_hash,
  depth: r.depth,
});

/** The public view (no spec internals, no secret hash). */
export const toWatch = ({ spec: _s, secretHash: _h, depth: _d, ...w }: WatchRecord): Watch => w;

export class WatchRepo {
  constructor(private readonly db: Db) {}

  insert(w: {
    agentId: string;
    kind: WatchKind;
    label: string;
    note: string;
    spec?: Record<string, unknown>;
    fireAt?: number | null;
    expiresAt?: number | null;
    repeat?: boolean;
    secretHash?: string | null;
    depth?: number;
  }): WatchRecord {
    const id = newId();
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO watches (id, agent_id, kind, label, note, spec, fire_at, expires_at, repeat,
           secret_hash, depth, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        w.agentId,
        w.kind,
        w.label,
        w.note,
        json.str(w.spec ?? {}),
        w.fireAt ?? null,
        w.expiresAt ?? null,
        w.repeat ? 1 : 0,
        w.secretHash ?? null,
        w.depth ?? 0,
        now,
        now,
      );
    return this.get(id)!;
  }

  get(id: string): WatchRecord | null {
    const r = this.db.query<Row, [string]>("SELECT * FROM watches WHERE id = ?").get(id);
    return r ? toRecord(r) : null;
  }

  /** Every active watch of every agent (re-armed on start). */
  active(): WatchRecord[] {
    return this.db
      .query<Row, []>("SELECT * FROM watches WHERE status = 'active' ORDER BY created_at")
      .all()
      .map(toRecord);
  }

  /** The agent's active watches, then its most recently ended ones. */
  forAgent(agentId: string, recent = 10): WatchRecord[] {
    const active = this.db
      .query<Row, [string]>(
        "SELECT * FROM watches WHERE agent_id = ? AND status = 'active' ORDER BY created_at",
      )
      .all(agentId);
    const ended = this.db
      .query<Row, [string, number]>(
        "SELECT * FROM watches WHERE agent_id = ? AND status != 'active' ORDER BY updated_at DESC LIMIT ?",
      )
      .all(agentId, recent);
    return [...active, ...ended].map(toRecord);
  }

  countActive(agentId: string): number {
    return this.db
      .query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM watches WHERE agent_id = ? AND status = 'active'",
      )
      .get(agentId)!.n;
  }

  /**
   * Move an active watch on: fired (once, or counted for a repeating one), cancelled, expired,
   * failed. Returns null when it isn't active any more, so two firings can't both win.
   */
  settle(id: string, status: WatchStatus, outcome: string | null): WatchRecord | null {
    const res = this.db
      .query(
        `UPDATE watches SET status = ?, outcome = ?, updated_at = ?,
           fire_count = fire_count + (CASE WHEN ? IN ('fired', 'active') THEN 1 ELSE 0 END)
         WHERE id = ? AND status = 'active'`,
      )
      .run(status, outcome, Date.now(), status, id);
    return res.changes ? this.get(id) : null;
  }
}
