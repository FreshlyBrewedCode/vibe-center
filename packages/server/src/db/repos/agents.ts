import type { Agent, ConfigValues } from "@vibe-center/shared";
import { type Db, json } from "../index.ts";

interface Row {
  id: string;
  name: string;
  description: string;
  avatar_emoji: string;
  avatar_color: string;
  system_prompt: string;
  harness_id: string;
  model: string | null;
  options: string;
  cwd: string;
  voice: string | null;
  created_at: number;
  updated_at: number;
}

function toAgent(r: Row): Agent {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    avatar: { emoji: r.avatar_emoji, color: r.avatar_color },
    systemPrompt: r.system_prompt,
    harnessId: r.harness_id,
    model: r.model,
    options: json.parse<ConfigValues>(r.options, {}),
    cwd: r.cwd,
    voice: r.voice,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export type AgentFields = Omit<Agent, "id" | "createdAt" | "updatedAt">;

export class AgentRepo {
  constructor(private readonly db: Db) {}

  list(): Agent[] {
    return this.db.query<Row, []>("SELECT * FROM agents ORDER BY sort_order, created_at").all().map(toAgent);
  }

  get(id: string): Agent | null {
    const row = this.db.query<Row, [string]>("SELECT * FROM agents WHERE id = ?").get(id);
    return row ? toAgent(row) : null;
  }

  insert(id: string, a: AgentFields): Agent {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO agents (id, name, description, avatar_emoji, avatar_color, system_prompt, harness_id,
                             model, options, cwd, voice, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        a.name,
        a.description,
        a.avatar.emoji,
        a.avatar.color,
        a.systemPrompt,
        a.harnessId,
        a.model,
        json.str(a.options),
        a.cwd,
        a.voice,
        now,
        now,
      );
    return this.get(id)!;
  }

  update(id: string, patch: Partial<AgentFields>): Agent | null {
    const cur = this.get(id);
    if (!cur) return null;
    const a = { ...cur, ...patch };
    this.db
      .query(
        `UPDATE agents SET name = ?, description = ?, avatar_emoji = ?, avatar_color = ?, system_prompt = ?,
                           harness_id = ?, model = ?, options = ?, cwd = ?, voice = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        a.name,
        a.description,
        a.avatar.emoji,
        a.avatar.color,
        a.systemPrompt,
        a.harnessId,
        a.model,
        json.str(a.options),
        a.cwd,
        a.voice,
        Date.now(),
        id,
      );
    return this.get(id);
  }

  delete(id: string): void {
    this.db.query("DELETE FROM agents WHERE id = ?").run(id);
  }

  countByHarness(harnessId: string): number {
    return (
      this.db
        .query<{ n: number }, [string]>("SELECT count(*) AS n FROM agents WHERE harness_id = ?")
        .get(harnessId)?.n ?? 0
    );
  }
}
