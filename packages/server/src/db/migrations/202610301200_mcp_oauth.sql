-- MCP OAuth for HTTP servers. `mcp_servers.oauth` holds the user's overrides (pre-registered
-- client id/secret, scopes); `mcp_oauth` the connection: discovery results, the dynamically
-- registered client and the tokens. Both are secrets, like headers: never returned by the API.

ALTER TABLE mcp_servers ADD COLUMN oauth TEXT;

CREATE TABLE mcp_oauth (
  server_id   TEXT PRIMARY KEY REFERENCES mcp_servers(id) ON DELETE CASCADE,
  state       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
