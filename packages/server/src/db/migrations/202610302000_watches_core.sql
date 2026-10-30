-- Background waits: durable watches an agent registers (timer, background tool call, another
-- agent's reply, webhook). The app waits; a firing starts a new `event` turn of the agent.

CREATE TABLE watches (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,              -- timer | tool | agent_reply | webhook
  label        TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'active',
  -- what to wait for, per kind: tool {tool, args, timeoutMs}, agent_reply {toAgentId}
  spec         TEXT NOT NULL DEFAULT '{}',
  fire_at      INTEGER,
  expires_at   INTEGER,
  repeat       INTEGER NOT NULL DEFAULT 0,
  fire_count   INTEGER NOT NULL DEFAULT 0,
  outcome      TEXT,
  -- webhooks: sha256 of the secret in the URL
  secret_hash  TEXT,
  -- how many watch firings led to the turn that registered it (chain limit)
  depth        INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX watches_agent ON watches(agent_id, status, updated_at);
CREATE INDEX watches_active ON watches(status) WHERE status = 'active';
