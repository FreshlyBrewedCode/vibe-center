import type { Harness, HarnessHealth, HarnessKind, HarnessProbe } from "@vibe-center/shared";
import { type Db, json } from "../index.ts";

/**
 * A harness as stored, env values in the clear; the domain layer masks them for clients and fills
 * in `resolvedCommand` from the adapter.
 */
export type HarnessRecord = Omit<Harness, "resolvedCommand" | "env"> & { env: Record<string, string> };

interface Row {
  id: string;
  name: string;
  kind: HarnessKind;
  command: string;
  args: string;
  env: string;
  builtin: number;
  health: string;
  probe: string | null;
  created_at: number;
  updated_at: number;
}

const UNKNOWN_HEALTH: HarnessHealth = { status: "unknown", message: null, checkedAt: null };

function toRecord(r: Row): HarnessRecord {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    command: r.command,
    args: json.parse<string[]>(r.args, []),
    env: json.parse<Record<string, string>>(r.env, {}),
    builtin: r.builtin === 1,
    health: json.parse<HarnessHealth>(r.health, UNKNOWN_HEALTH),
    probe: json.parse<HarnessProbe | null>(r.probe, null),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class HarnessRepo {
  constructor(private readonly db: Db) {}

  list(): HarnessRecord[] {
    return this.db
      .query<Row, []>("SELECT * FROM harnesses ORDER BY builtin DESC, created_at")
      .all()
      .map(toRecord);
  }

  get(id: string): HarnessRecord | null {
    const row = this.db.query<Row, [string]>("SELECT * FROM harnesses WHERE id = ?").get(id);
    return row ? toRecord(row) : null;
  }

  insert(
    h: Pick<HarnessRecord, "id" | "name" | "kind" | "command" | "args" | "env" | "builtin">,
  ): HarnessRecord {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO harnesses (id, name, kind, command, args, env, builtin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(h.id, h.name, h.kind, h.command, json.str(h.args), json.str(h.env), h.builtin ? 1 : 0, now, now);
    return this.get(h.id)!;
  }

  update(
    id: string,
    patch: Partial<Pick<HarnessRecord, "name" | "command" | "args" | "env">>,
  ): HarnessRecord | null {
    const cur = this.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.db
      .query("UPDATE harnesses SET name = ?, command = ?, args = ?, env = ?, updated_at = ? WHERE id = ?")
      .run(next.name, next.command, json.str(next.args), json.str(next.env), Date.now(), id);
    return this.get(id);
  }

  setHealth(id: string, health: HarnessHealth): void {
    this.db.query("UPDATE harnesses SET health = ? WHERE id = ?").run(json.str(health), id);
  }

  setProbe(id: string, probe: HarnessProbe): void {
    this.db.query("UPDATE harnesses SET probe = ? WHERE id = ?").run(json.str(probe), id);
  }

  delete(id: string): void {
    this.db.query("DELETE FROM harnesses WHERE id = ? AND builtin = 0").run(id);
  }
}
