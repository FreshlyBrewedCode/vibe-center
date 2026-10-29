# Vibe Center: architecture (v1)

What exists after phase 1 and phase 2a (MCP gateway), how it fits together, and where phases 2b
(voice) and 2c (UI) plug in. The product spec is [PRODUCT.md](PRODUCT.md); commands and conventions are in
[AGENTS.md](../AGENTS.md).

## Components

```
browser (any device on the tailnet)
  │  https://<host>.ts.net:7443  (tailscale serve, foreground; TLS by Tailscale)
  ▼
vibe-center start  (one Bun process, binds 127.0.0.1:7880 only)
  ├─ Hono JSON API      /api/*      cookie auth, zod-validated bodies
  ├─ WebSocket channel  /ws         typed ServerEvents to every device
  ├─ MCP gateway        /mcp        streamable HTTP, per-session bearer credential, loopback only
  ├─ SPA                /*          packages/web/dist  (dev: Vite on port+1 proxies /api,/ws)
  ├─ control socket     ~/.vibe-center/control.sock (0600)  ← `vibe-center link`
  ├─ SQLite             ~/.vibe-center/vibe-center.db  (WAL, FTS5)
  ├─ one harness process per active agent, ACP over stdio
  │    claude-agent-acp (node) │ opencode acp │ custom command
  │      └─ MCP client → http://127.0.0.1:<port>/mcp  (the gateway; one "vibe" server per session)
  └─ one process/connection per configured upstream MCP server (stdio child or HTTP client)
```

Phase 2b adds the Python voice worker as a child process that calls back into the app.

## Layout

```
packages/shared/src/      types shared by server and web (no runtime deps but zod)
  domain.ts               Agent, Harness, Conversation, Session, Message (kinds), Device, Presence
  api.ts                  paths, zod request schemas, response types
  events/{core,mcp,voice}.ts + index.ts   the ServerEvent union, one file per phase
packages/server/src/
  cli.ts                  `vibe-center start|link`
  server.ts               composition root: services + HTTP + WS + static; mount points
  services.ts             wires repos, bus and domain services (the MCP provider seam lives here)
  config.ts               data dir, ports
  control.ts, tailscale.ts
  auth/auth.ts            link tokens, device sessions
  http/                   api.ts (core routes), mcp-api.ts, middleware.ts, ws.ts, static.ts, origin.ts
  domain/                 chat.ts, turns.ts, agents.ts, harnesses.ts, presence.ts, errors.ts
  acp/                    the harness layer (below); knows nothing about storage or HTTP
  mcp/                    the MCP gateway, upstream clients, tool catalog, built-in tools (below)
  db/                     index.ts (open + migrate), migrations/*.sql, repos/*.ts
  events/bus.ts           in-process EventBus
packages/server/test/     bun tests; fake-agent.ts is a scripted ACP agent
packages/web/src/         Vite SPA (below)
e2e/                      Playwright
```

## Auth

- `vibe-center start` mints a link token: 32 random bytes, kept hashed in memory, single use,
  10 minutes. `vibe-center link` asks the running server for another over the unix control
  socket (mode 0600 inside the 0700 data dir).
- The link is `/login#token=…`. The token is in the fragment, so it never reaches logs or
  `Referer`. The SPA POSTs it to `/api/auth/exchange` (a POST, so link previews can't burn it).
- The exchange creates a **device** row and sets `vc_session`: HttpOnly, Secure, SameSite=Strict,
  400 days. The DB stores only its SHA-256. Every `/api` route except the exchange and the `/ws`
  upgrade require it. State-changing requests and the WS upgrade also need a same-origin
  `Origin` (`http/origin.ts`, which understands `tailscale serve` and the Vite proxy).
- Devices can be listed and revoked (`/api/devices`). Revoking one publishes `device.revoked`
  and closes that device's sockets (close code 4401).
- The server only binds loopback. Remote devices come in only through `tailscale serve`
  (`--https-port`, default 7443, because 443 and 8443 are taken on dev). `--local` skips it.
  Chromium accepts Secure cookies on `http://localhost`, which the tests rely on.

## Data model (`db/migrations/`)

| table | what |
|---|---|
| `harnesses` | presets (`claude-code`, `opencode`, seeded, builtin) and custom ones (command/args/env); cached `health` and `probe` (capabilities + config options = models, modes, …) |
| `agents` | name, description, avatar (emoji + color), system prompt, harness, model, other config option values (`options`), cwd, voice |
| `conversations` | one `dm` per agent; `active_session_id`; `last_read_seq` for unread |
| `sessions` | one row per ACP session; `acp_session_id` for resume after restarts; `ended` on "New session" |
| `turns` | one prompt and its outcome: `source` (user/voice/agent/event), `from_agent_id`, status, stop reason, error |
| `messages` | `seq` (global order) + `kind`: text, thought, tool_call, permission, plan, voice_transcript, session (divider), error; `data` JSON per kind (see `shared/src/domain.ts`) |
| `messages_fts` | FTS5 over message text; streaming messages are indexed once they stop streaming |
| `mcp_servers` | configured MCP servers: stdio (command/args/env/cwd) or http (url/headers), cached tool list and status; row `builtin` is the app's own server |
| `agent_tools` | per-agent tool enablement: `tool_name '*'` = the server switch, other rows = per-tool overrides |
| `mcp_tool_calls` | every call the gateway served: agent, session, turn, server, tool, args, result, timing, and the tool_call message it was attached to |
| `memories` (+ FTS5) | the memory tools' store; `agent_id NULL` = shared |
| `devices` | device sessions (hashed secret), last seen, revoked |
| `settings` | key → JSON (voice URLs, appearance, …) |

**Migrations** are `*.sql` files applied in name order and tracked by **name**, so parallel
branches never fight over a number. Name new ones `<YYYYMMDDHHmm>_<phase>_<what>.sql`. Never
edit an applied migration; add a new one.

## The ACP layer (`packages/server/src/acp/`)

- `protocol.ts`: the single import point for `@agentclientprotocol/sdk` (its `unstable`
  surface, which has the spec `systemPrompt` field).
- `process.ts` / **`AcpProcess`**: spawns one harness in its own process group, `initialize`s
  it and wires `session/update`, `session/request_permission` and extension notifications.
  `close()` stops the whole group (SIGTERM, then SIGKILL). `raceExit` turns a crash into an
  error that includes the stderr tail instead of a hang.
- `runtime.ts` / **`AgentRuntime`**: everything for one agent: lazy spawn; session
  create/resume (`session/resume`, else `session/load` with the replay dropped, else a fresh
  session plus a `resumeFailed` report); model and options via `session/set_config_option`
  (values the harness doesn't offer are skipped with a warning); a prompt queue (one turn at a
  time); `cancel()` (sends `session/cancel`, answers pending permissions with `cancelled`, and
  restarts the harness if it ignores the cancel past `cancelGraceMs`); per-turn **idle
  timeouts** (`idleMs` without any update, `toolIdleMs` while a tool runs, none while waiting
  for a permission); permission requests held until `respondPermission()`; presence
  (idle/thinking/working/waiting/error); `reconfigure()` (model/options on the live session,
  launch changes restart the process when idle and resume the session); `newSession()`.
  It emits `RuntimeEvent`s and knows nothing about storage.
- `adapters/`: one **`HarnessAdapter`** per preset. Adapters only map persona, model and app
  tools onto what the harness understands; everything that's plain ACP lives in the runtime.
  - Claude Code: `node <claude-agent-acp>/dist/index.js`; persona via the spec `systemPrompt`
    (append; falls back to `_meta.systemPrompt.append`); `_meta.claudeCode.options` with
    `ENABLE_TOOL_SEARCH=false`, `promptSuggestions:false`, the model, and `allowedTools` from
    the MCP setup. Auth comes from the `claude` CLI login; `_auth/status_update` feeds health.
  - OpenCode: `opencode acp`; persona as an `instructions` file in the agent's state dir passed
    through `OPENCODE_CONFIG_CONTENT` (the agent's cwd stays untouched); model via config
    option. OpenCode can hang on provider errors, which the idle timeout covers.
  - Custom: command/args/env; spec `systemPrompt` if advertised, else the persona goes as a
    `<system-instructions>` block before the first prompt of each session.
- `probe.ts`: starts a harness in a temp dir, reads capabilities and config options from
  `session/new`, optionally sends a one-word prompt (`deep`), and returns health
  (`ok`/`not_installed`/`auth_required`/`error`). `HarnessService` caches the result and
  refreshes the cached options whenever a live session reports them.
- `mcp.ts`: the **`McpProvider` seam**. The runtime asks it for `{ servers, allowedTools }` for
  every session it creates or resumes (passing the harness's `initialize` capabilities); the
  servers go into `session/new|resume|load`. The app's provider is the MCP gateway (below);
  `noMcp` remains for probes and tests.

## Domain layer (`packages/server/src/domain/`)

- **`ChatService`** owns one `AgentRuntime` per agent (created on first use) and is the **single
  entry point for prompts**: `prompt(agentId, { text, source, fromAgentId?, display?,
  replyKind?, note?, idleTimeoutMs?, onUpdate? })` returns `{ turnId, message, done }`, with
  `done` resolving to the result plus the reply text. The UI's send, the voice worker and
  agent-to-agent messages all go through it. It also does cancel, new session (divider message +
  `session.started`), permission answers, read markers and reconfiguration.
- **`TurnRecorder`** turns one turn's runtime events into messages: text and thought chunks
  stream into a message (`message.delta`), and a tool call or permission request closes the
  segment. That fixes the "On it.Done" glue the spike found. Each tool call and permission request
  is one message updated in place, the plan is one message, and an error ends the turn with an
  `error` message.
- **`AgentService`** (CRUD; every agent gets its DM and first session in one transaction),
  **`HarnessService`** (presets, custom harnesses, probe/health), **`PresenceStore`** (runtime
  presence plus an override layer for `in_call`).
- On start, turns and messages left `running`/`streaming`/`pending` by a dead server are
  marked interrupted/cancelled.

## MCP gateway and built-in tools (`packages/server/src/mcp/`, phase 2a)

`McpService` (`mcp/service.ts`, `services.mcp`) holds the pieces: the server registry, per-agent
tool selection, memories for the UI, and the gateway.

**Gateway** (`gateway.ts`, mounted at `/mcp` in `server.ts`):

- **Transport:** MCP streamable HTTP on the app's loopback port, stateful (one MCP session per
  harness connection, `mcp-session-id`). Both presets advertise `mcpCapabilities.http` (claude-agent-acp
  0.99: `http`+`sse`; `opencode acp` 1.18: `http`+`sse`). For a harness that doesn't, the provider
  hands out a **stdio bridge** instead (`mcp/bridge.ts`, run with the server's bun; URL and token in
  its env), which forwards JSON-RPC unchanged to the same endpoint.
- **Credentials:** `forSession` mints 32 random bytes per ACP session (create or resume), sent as
  `Authorization: Bearer …`, kept as SHA-256 in memory, bound to `{ agentId, sessionKey }`. An
  agent has one live credential: minting revokes the previous one and closes its MCP sessions, as
  does deleting the agent. Credentials don't survive a restart, nor do the harness processes. The
  endpoint also refuses anything with `X-Forwarded-For` (came through `tailscale serve`) or
  `Origin` (a browser), whatever the credential.
- **What a session sees:** exactly the agent's enabled tools (`catalog.ts`): built-ins under their
  own names (`memory_save`), upstream tools as `<server>__<tool>` (Claude Code shows
  `mcp__vibe__github__create_issue`, OpenCode `vibe_github__create_issue`; names over 53 chars are
  shortened with a hash so Claude's 64-char limit holds). The server's `instructions` tell the
  model when to use memory and search (Claude Code puts them in its system prompt).
- **Claude Code:** `allowedTools: ["mcp__vibe"]` pre-allows every gateway tool (no permission
  round trip; selection is enforced by the gateway), and the adapter's `ENABLE_TOOL_SEARCH=false`
  loads them up front.
- **Tool selection** resolves per tool: a per-tool override, else the agent's server switch, else
  the default: **built-in tools on, any added server off** until enabled for that agent (a new
  server shouldn't silently give every agent new powers). Tools a server adds later follow the
  server switch. Globally disabled servers offer nothing.
- **Live changes:** a selection change (or a server's tools/name/enabled changing) sends
  `notifications/tools/list_changed` to the agent's live MCP sessions. Claude Code refreshes on it
  mid-session (verified: an enabled server's tools became callable, and a disabled tool was refused
  by Claude Code itself, in the same session). Independently, every `tools/call` is checked against
  the current selection, so a disabled tool never runs, whatever the harness cached. Harnesses that
  ignore `list_changed` pick changes up with the next session.
- **Upstream servers** (`upstream.ts`): one shared MCP client per configured server, not per
  session (a stdio server runs once for all agents). Connects on create/update/refresh and on
  start (`probeOnStart`), lazily otherwise; reconnects on the next call after a crash; follows the
  server's own `list_changed`. Status (`connecting/connected/error` with stderr tail) and the
  discovered tools are cached in `mcp_servers` and published as `mcp.server.upsert`. stdio servers
  get the MCP SDK's default env (HOME, PATH, USER, …) plus their configured env, not the app's
  whole environment. HTTP tries streamable HTTP, then the old HTTP+SSE transport.
- **Secrets:** env values and headers are stored in SQLite (data dir is 0700) and never returned:
  the API shows keys and, for values of 12+ chars, the last 4. Writes send `{ keep: true }` to keep
  a stored value; keys left out are removed. Put secrets there, not in args or the URL.
- **Recording** (`recorder.ts`): every call is logged in `mcp_tool_calls`, then attached to the
  harness's own ACP tool_call message as `data.gateway` (server, tool, args, result, status,
  duration), matched by the tool-use id Claude Code sends in `_meta["claudecode/toolUseId"]`, else
  the exposed name in the title, else identical arguments. Harnesses may announce a call after
  running it, so unmatched calls wait for new tool_call messages of the turn; a call still
  unmatched 1.5 s after it finished gets a tool_call message of its own. `TurnRecorder` keeps
  `gateway` when the harness updates the message.

**Built-in tools** (`mcp/builtin/`, zod schemas → JSON Schema):

- **memory:** `memory_save`, `memory_search` (FTS5 prefix match, any word, plus tags),
  `memory_list`, `memory_update`, `memory_delete`. Scope `agent` (default) or `shared`; an agent can
  change its own and shared memories only. The descriptions say when to remember and when to look.
- **conversation search:** `search_conversations` (own DM by default; `scope: "all"`, `agent`,
  `role`, `since`/`until`; text messages only; the current turn is left out) and
  `read_conversation` (messages around a hit). SQL in `db/repos/message-search.ts`.
- **agents:** `list_agents`; `send_message_to_agent(agent, message)` returns at once. The target
  gets `chat.prompt(target, { source: "agent", fromAgentId, note })`; when its turn ends, the reply
  (or the failure) goes into the sender's session as `chat.prompt(sender, { source: "event",
  fromAgentId: target, note })`. Both DMs show it: the target's as a message from the sender, the
  sender's as the reply, labelled in the UI. **Loop protection:** no self-messages; a hop count per
  turn (user prompt 0, each message +1, a delivered reply keeps the hop of what it answers) with
  `MAX_HOPS = 3`, so a ping-pong ends after a few rounds; at most 5 unanswered messages per sender.

## Live updates (`/ws`, `shared/src/events/`)

One socket per tab; every event goes to every device (single user). The client sends only
`ping`. Mutations go through HTTP.

| event | when |
|---|---|
| `hello` | first frame; the client refetches everything it caches (covers reconnects) |
| `message.upsert` | message created or changed (status, tool progress, permission outcome) |
| `message.delta` | streamed text; `offset` = text length before it. A client whose cached text has a different length refetches instead of garbling |
| `agent.upsert` / `agent.deleted` / `agent.presence` | sidebar state |
| `conversation.unread` | unread count + read marker, after new agent messages or a read |
| `session.started`, `harness.upsert`, `device.revoked` | as named |
| `mcp.server.upsert` / `mcp.server.deleted` | MCP server config, status or discovered tools changed |
| `agent.tools.changed` | an agent's tool groups changed (`agentId: null` = all agents) |
| `memory.upsert` / `memory.deleted` | a memory changed (by an agent's tool or the UI) |

Adding events: put them in your phase's file (`events/mcp.ts`, `events/voice.ts`). Clients
ignore unknown types, so new events never break older tabs. Server code publishes on the
`EventBus` (`services.bus.publish`), and the WS hub forwards everything.

## Web app (`packages/web/src/`)

- Routing: TanStack Router, file routes in `routes/` (the `_app` layout is the signed-in shell
  that opens the event socket; `login.tsx` exchanges the token). `routeTree.gen.ts` is generated
  by the Vite plugin and committed.
- Server state: TanStack Query only. Keys and hooks are in `lib/queries.ts`, the fetch client in
  `lib/api.ts` (any 401 drops to the signed-out screen). `lib/events.ts` applies events to the
  same cache in `applyEvent`; `subscribe()` is for side effects (notifications, call UI).
  Components never hold copies of server state.
- UI: shadcn/ui components in `components/ui/` (add more with `bunx shadcn@4.23.0 add <name>`
  in `packages/web`), and theme tokens in `index.css`, including the presence colours. Use the
  semantic classes (`bg-background`, `text-muted-foreground`, `bg-presence-working`), not raw
  colours. Theme: `lib/theme.ts` (light/dark/system).

## Extension points

Ownership below is meant to keep parallel worktrees from colliding. "Shared" files are expected
to change by a line or two. Keep it that way, and expect trivial merges there.

### Phase 2a: MCP gateway and built-in tools (done)

Described above. To add a built-in tool, add it to a file in `mcp/builtin/` with `tool({ name,
description, schema, run })`; it appears in every agent's built-in group (on by default) and in
Settings. Gateway-served tool calls carry `data.gateway` on their tool_call message. Files:
`packages/server/src/mcp/**`, `http/mcp-api.ts`, `db/repos/{mcp-servers,memories,message-search}.ts`,
`shared/src/api-mcp.ts`, `shared/src/events/mcp.ts`; web `routes/_app/settings/mcp.tsx`,
`routes/_app/memories.tsx`, `components/mcp/**`.

### Phase 2b: voice worker

- Move `prototype/voice-loop` to `services/voice/` (Python + uv) and run it as a managed child
  process of the server (a new `packages/server/src/voice/` module: spawn, health, restart,
  URL settings in the `settings` table). STT/TTS stay separate services
  (`services/speech-gpu`, from `prototype/gpu-speech`).
- The worker's **LLM step calls back into the app**. Add an HTTP (or WS) bridge under
  `packages/server/src/voice/`, authenticated with a per-process secret from the worker's env,
  not the device cookie. It calls `chat.prompt(agentId, { source: "voice", display:
  "voice_transcript", replyKind: "voice_transcript", note: <voice-mode note>, idleTimeoutMs:
  <short>, onUpdate })` and streams the reply text back. Treat `tool_call` updates as a sentence
  boundary and the filler cue trigger. `done` resolves with the full reply. Barge-in maps to
  `chat.cancel(conversationId)` (2–9 ms on Claude in the spike).
- Presence: `presence.setOverride(agentId, { presence: "in_call", detail })` for the call,
  `null` after it.
- Browser signalling for WebRTC goes through the app's origin (cookie-authenticated, behind the
  same `tailscale serve`). Call UI events go in `events/voice.ts`.
- **Owns:** `services/voice/**`, `services/speech-gpu/**`, `packages/server/src/voice/**`,
  `shared/src/events/voice.ts`, a new `shared/src/api-voice.ts`, new migrations, web
  `routes/_app/settings/voice.tsx`, `components/voice/**` (the call button and panel are
  mounted in the DM header). **Shared:** `server.ts`, `services.ts`, `routes/_app/agents/$agentId/index.tsx`
  (one line to mount the call button), the `SECTIONS` list.

### Phase 2c: UI build-out

- Everything in PRODUCT.md's UX section on top of the existing patterns: ⌘K switcher and
  global search (`GET /api/search` exists), details panel, template picker, code highlighting,
  collapsed thinking and plans, notifications (`lib/events.ts` `subscribe`), mobile layout,
  failure states with `ApiError.hint`, full settings (General: data dir, tailnet URL; Devices;
  Harnesses incl. custom harness CRUD, whose API exists), message pagination (`?before=seq`
  exists), and a combobox for long model lists (OpenCode offers ~580).
- **Owns:** `packages/web/**` except the files 2a/2b add above. Keep `lib/queries.ts`,
  `lib/events.ts` and `lib/api.ts` as the only data layer. **Shared:** if the UI needs new
  API fields, add them in `shared/src/domain.ts`/`api.ts` and in `packages/server/src/http/api.ts`.

## Known gaps

- No message pagination UI, no code highlighting, no ⌘K/search UI, no notifications, no custom
  harness form (API only), no MCP or voice (by design).
- Unread counts every agent text/permission/error message, including replies you watched
  stream in while the DM was open; the DM marks them read as they arrive, so other devices
  briefly show a badge.
- The link token store is in memory: a server restart invalidates outstanding links (device
  sessions survive).
- `vc_session` is not port-scoped. Two servers on `localhost` (e.g. dev and e2e) share the
  cookie name, so signing in to one replaces the other's cookie in the same browser profile.
- Harness processes stay up while the server runs (no idle reaping yet). Each active agent
  holds one process.
- Steering (sending into a running turn; claude-agent-acp advertises it) isn't used. Prompts
  queue.
- MCP (phase 2a): upstream servers are shared by all agents (one process/connection per server),
  so stateful servers (a browser, a shell) share state between agents. Only tools are proxied
  (no MCP resources, prompts, sampling or elicitation from upstream servers). OAuth for HTTP MCP
  servers isn't supported; use a header token. Hop counts for agent messages live in memory.
- A harness that runs a gateway tool without reporting it over ACP gets a card from the gateway
  1.5 s after the call; one that reports a call later than that shows two cards.
