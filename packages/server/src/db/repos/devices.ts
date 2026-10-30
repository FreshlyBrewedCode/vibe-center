import type { Device } from "@vibe-center/shared";
import type { Db } from "../index.ts";

interface Row {
  id: string;
  name: string;
  token_hash: string;
  user_agent: string | null;
  created_at: number;
  last_seen_at: number;
  revoked_at: number | null;
}

const toDevice = (r: Row, currentId?: string): Device => ({
  id: r.id,
  name: r.name,
  userAgent: r.user_agent,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  revokedAt: r.revoked_at,
  current: r.id === currentId,
});

export class DeviceRepo {
  constructor(private readonly db: Db) {}

  insert(d: { id: string; name: string; tokenHash: string; userAgent: string | null }): Device {
    const now = Date.now();
    this.db
      .query(
        "INSERT INTO devices (id, name, token_hash, user_agent, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(d.id, d.name, d.tokenHash, d.userAgent, now, now);
    return this.get(d.id)!;
  }

  get(id: string, currentId?: string): Device | null {
    const r = this.db.query<Row, [string]>("SELECT * FROM devices WHERE id = ?").get(id);
    return r ? toDevice(r, currentId) : null;
  }

  /** The non-revoked device holding this session token hash. */
  byTokenHash(hash: string): Device | null {
    const r = this.db
      .query<Row, [string]>("SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL")
      .get(hash);
    return r ? toDevice(r) : null;
  }

  list(currentId?: string): Device[] {
    return this.db
      .query<Row, []>("SELECT * FROM devices ORDER BY revoked_at IS NOT NULL, last_seen_at DESC")
      .all()
      .map((r) => toDevice(r, currentId));
  }

  touch(id: string): void {
    this.db.query("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(Date.now(), id);
  }

  rename(id: string, name: string): boolean {
    return this.db.query("UPDATE devices SET name = ? WHERE id = ?").run(name, id).changes > 0;
  }

  revoke(id: string): boolean {
    return (
      this.db
        .query("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(Date.now(), id).changes > 0
    );
  }
}
