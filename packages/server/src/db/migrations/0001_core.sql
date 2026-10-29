-- Core schema for v1. Later phases add their own migration files (see db/index.ts); tables for
-- MCP servers, tool enablement and memories are modelled here already so phase 2a can fill them.

CREATE TABLE harnesses (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('claude-code', 'opencode', 'custom')),
  command     TEXT NOT NULL DEFAULT '',
  args        TEXT NOT NULL DEFAULT '[]',   -- JSON string[]
  env         TEXT NOT NULL DEFAULT '{}',   -- JSON Record<string,string>
  builtin     INTEGER NOT NULL DEFAULT 0,
  health      TEXT NOT NULL DEFAULT '{"status":"unknown","message":null,"checkedAt":null}',
  probe       TEXT,                         -- JSON HarnessProbe (cached models/config options)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE agents (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  avatar_emoji   TEXT NOT NULL,
  avatar_color   TEXT NOT NULL,
  system_prompt  TEXT NOT NULL DEFAULT '',
  harness_id     TEXT NOT NULL REFERENCES harnesses(id),
  model          TEXT,
  options        TEXT NOT NULL DEFAULT '{}', -- JSON ConfigValues
  cwd            TEXT NOT NULL,
  voice          TEXT,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- A DM is a conversation of kind 'dm' with exactly one agent.
CREATE TABLE conversations (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL DEFAULT 'dm' CHECK (kind IN ('dm')),
  agent_id           TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  active_session_id  TEXT,
  last_read_seq      INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX conversations_dm_agent ON conversations(agent_id) WHERE kind = 'dm';

-- One ACP session per row; "New session" ends the active one. acp_session_id lets us resume
-- the harness session after a server or harness restart.
CREATE TABLE sessions (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id         TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  acp_session_id   TEXT,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  config_state     TEXT,   -- JSON: last configOptions / available commands reported by the harness
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER
);
CREATE INDEX sessions_conversation ON sessions(conversation_id, started_at);

-- One prompt sent to the harness and everything it produced.
CREATE TABLE turns (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source          TEXT NOT NULL CHECK (source IN ('user', 'voice', 'agent', 'event')),
  from_agent_id   TEXT,
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'complete', 'cancelled', 'error', 'interrupted')),
  stop_reason     TEXT,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  ended_at        INTEGER
);
CREATE INDEX turns_session ON turns(session_id, created_at);

-- seq is the rowid alias: stable for FTS5 external content, and a global order for pagination
-- and unread counting.
CREATE TABLE messages (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  id               TEXT NOT NULL UNIQUE,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id          TEXT REFERENCES turns(id) ON DELETE SET NULL,
  role             TEXT NOT NULL CHECK (role IN ('user', 'agent', 'system')),
  kind             TEXT NOT NULL CHECK (kind IN ('text', 'thought', 'tool_call', 'permission', 'plan',
                                                 'voice_transcript', 'session', 'error')),
  status           TEXT NOT NULL DEFAULT 'complete'
                   CHECK (status IN ('streaming', 'complete', 'cancelled', 'error', 'pending')),
  text             TEXT NOT NULL DEFAULT '',
  data             TEXT,   -- JSON, shape depends on kind (see shared/src/domain.ts)
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX messages_conversation ON messages(conversation_id, seq);
CREATE INDEX messages_turn ON messages(turn_id);

-- Full-text index over message text, for conversation search (phase 2a tools, ⌘K search in 2c).
-- Streaming messages are indexed once they stop streaming, so a reply is not re-indexed per chunk.
CREATE VIRTUAL TABLE messages_fts USING fts5(
  text,
  content = 'messages',
  content_rowid = 'seq',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages WHEN new.status != 'streaming' BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.seq, new.text);
END;
CREATE TRIGGER messages_fts_update AFTER UPDATE OF text, status ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text)
    SELECT 'delete', old.seq, old.text WHERE old.status != 'streaming';
  INSERT INTO messages_fts(rowid, text) SELECT new.seq, new.text WHERE new.status != 'streaming';
END;
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages WHEN old.status != 'streaming' BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.seq, old.text);
END;

-- MCP servers configured in the app (phase 2a). transport 'builtin' is the app's own server.
CREATE TABLE mcp_servers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  transport   TEXT NOT NULL CHECK (transport IN ('stdio', 'http', 'builtin')),
  command     TEXT,
  args        TEXT NOT NULL DEFAULT '[]',
  env         TEXT NOT NULL DEFAULT '{}',
  url         TEXT,
  headers     TEXT NOT NULL DEFAULT '{}',
  enabled     INTEGER NOT NULL DEFAULT 1,
  tools       TEXT,   -- JSON: discovered tool list cache
  status      TEXT,   -- JSON: last connection status
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Per-agent tool enablement, grouped by server. tool_name '*' = every tool of the server.
CREATE TABLE agent_tools (
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  server_id  TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  tool_name  TEXT NOT NULL,
  enabled    INTEGER NOT NULL,
  PRIMARY KEY (agent_id, server_id, tool_name)
);

-- Memories (phase 2a built-in tool). agent_id NULL = shared between agents.
CREATE TABLE memories (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  agent_id    TEXT REFERENCES agents(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX memories_agent ON memories(agent_id);
CREATE VIRTUAL TABLE memories_fts USING fts5(content, content = 'memories', content_rowid = 'seq');
CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.seq, new.content);
END;
CREATE TRIGGER memories_fts_update AFTER UPDATE OF content ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.seq, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.seq, new.content);
END;
CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.seq, old.content);
END;

-- Browsers holding a device-session cookie. Only a SHA-256 of the cookie value is stored.
CREATE TABLE devices (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  user_agent    TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  revoked_at    INTEGER
);

-- App settings (voice worker URLs, appearance, ...): key → JSON value.
CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
