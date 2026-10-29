-- Phase 2a: MCP gateway. Working directory for stdio servers, the built-in server's row (so
-- agent_tools can reference it), and a log of every tool call the gateway served.

ALTER TABLE mcp_servers ADD COLUMN cwd TEXT;

INSERT INTO mcp_servers (id, name, transport, created_at, updated_at)
VALUES ('builtin', 'builtin', 'builtin', 0, 0);

CREATE TABLE mcp_tool_calls (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id   TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  turn_id      TEXT REFERENCES turns(id) ON DELETE SET NULL,
  -- the harness's tool_call message this call was matched to (shown as its gateway details)
  message_id   TEXT REFERENCES messages(id) ON DELETE SET NULL,
  server_id    TEXT,
  server_name  TEXT NOT NULL,
  tool         TEXT NOT NULL,
  args         TEXT NOT NULL DEFAULT '{}',
  result       TEXT,
  is_error     INTEGER NOT NULL DEFAULT 0,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER
);
CREATE INDEX mcp_tool_calls_turn ON mcp_tool_calls(turn_id);
CREATE INDEX mcp_tool_calls_agent ON mcp_tool_calls(agent_id, started_at);
