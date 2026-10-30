import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDataDir } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { createRepos } from "../src/db/repos/index.ts";

function setup() {
  const repos = createRepos(openDb(":memory:"));
  repos.harnesses.insert({
    id: "h",
    name: "H",
    kind: "custom",
    command: "x",
    args: [],
    env: {},
    builtin: false,
  });
  repos.agents.insert("a", {
    name: "Ada",
    description: "",
    avatar: { emoji: "🤖", color: "#336699" },
    systemPrompt: "",
    harnessId: "h",
    model: null,
    options: {},
    cwd: "/tmp",
    voice: null,
  });
  const conv = repos.conversations.createDm("a");
  const session = repos.conversations.createSession(conv.id, "a");
  return { repos, conv, session };
}

describe("database", () => {
  test("migrations are idempotent and tracked by name", () => {
    const db = openDb(":memory:");
    const names = db.query<{ name: string }, []>("SELECT name FROM schema_migrations").all();
    expect(names.map((n) => n.name)).toContain("0001_core.sql");
  });

  test("streaming messages enter the FTS index once they stop streaming", () => {
    const { repos, conv, session } = setup();
    const base = { conversationId: conv.id, sessionId: session.id, turnId: null, role: "agent" as const };
    const m = repos.messages.insert({ ...base, kind: "text", status: "streaming", text: "the quick " });
    repos.messages.appendText(m.id, "brown fox");
    expect(repos.messages.search("brown", { limit: 10 })).toHaveLength(0);
    repos.messages.update(m.id, { status: "complete" });
    const hits = repos.messages.search("bro", { limit: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet).toContain("<mark>brown</mark>");
    expect(hits[0]!.agentId).toBe("a");
    repos.messages.update(m.id, { text: "changed text" });
    expect(repos.messages.search("brown", { limit: 10 })).toHaveLength(0);
    expect(repos.messages.search("changed", { limit: 10 })).toHaveLength(1);
  });

  test("unread counts agent messages after the read marker", () => {
    const { repos, conv, session } = setup();
    const base = {
      conversationId: conv.id,
      sessionId: session.id,
      turnId: null,
      status: "complete" as const,
    };
    repos.messages.insert({ ...base, role: "user", kind: "text", text: "hi" });
    const reply = repos.messages.insert({ ...base, role: "agent", kind: "text", text: "hello" });
    repos.messages.insert({ ...base, role: "agent", kind: "tool_call", text: "Read file" });
    expect(repos.messages.unreadCount(conv.id, 0)).toBe(1);
    expect(repos.conversations.markRead(conv.id, reply.seq)).toBe(reply.seq);
    expect(repos.conversations.markRead(conv.id, 0)).toBe(reply.seq);
    expect(repos.messages.unreadCount(conv.id, reply.seq)).toBe(0);
  });

  test("closeStale cancels streaming messages and pending permissions", () => {
    const { repos, conv, session } = setup();
    const base = { conversationId: conv.id, sessionId: session.id, turnId: null, role: "agent" as const };
    const s = repos.messages.insert({ ...base, kind: "text", status: "streaming", text: "half" });
    const p = repos.messages.insert({
      ...base,
      kind: "permission",
      status: "pending",
      text: "Run",
      data: { requestId: "r", outcome: null },
    });
    repos.messages.closeStale();
    expect(repos.messages.get(s.id)?.status).toBe("cancelled");
    const perm = repos.messages.get(p.id);
    expect(perm?.status).toBe("cancelled");
    expect(perm?.kind === "permission" && perm.data.outcome).toBe("cancelled");
  });
});

test("a data dir and database created with looser modes are tightened on open", () => {
  const dir = mkdtempSync(join(tmpdir(), "vc-modes-"));
  chmodSync(dir, 0o755);
  const path = join(dir, "vibe-center.db");
  new Database(path, { create: true }).close();
  chmodSync(path, 0o644);
  ensureDataDir(dir);
  openDb(path).close();
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});
