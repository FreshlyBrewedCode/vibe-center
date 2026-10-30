import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Db = Database;

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

/**
 * Opens (and migrates) the SQLite database. Pass ":memory:" in tests.
 *
 * Migrations are the `*.sql` files in db/migrations, applied in file-name order and tracked by
 * name, not by a counter, so parallel branches can each add a file without renumbering. Name new
 * files `<YYYYMMDDHHmm>_<phase>_<what>.sql`, e.g. `202611011200_mcp_server_status.sql`.
 */
export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  // 0600 before WAL mode creates -wal/-shm (SQLite gives them the DB file's mode); older DBs
  // created 0644 get tightened here too
  if (path !== ":memory:") {
    for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
  }
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: Db, dir = MIGRATIONS_DIR): string[] {
  db.run("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM schema_migrations")
      .all()
      .map((r) => r.name),
  );
  const pending = readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && !applied.has(f))
    .sort();
  for (const name of pending) {
    const sql = readFileSync(join(dir, name), "utf8");
    db.transaction(() => {
      db.run(sql);
      db.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(name, Date.now());
    })();
  }
  return pending;
}

export const newId = (): string => Bun.randomUUIDv7();

export const json = {
  parse<T>(value: string | null | undefined, fallback: T): T {
    if (value == null) return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  },
  str(value: unknown): string {
    return JSON.stringify(value ?? null);
  },
};
