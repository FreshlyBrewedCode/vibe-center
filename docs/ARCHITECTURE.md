# Vibe Center: architecture (v1, phase 1)

What exists after phase 1, how it fits together, and where phases 2a (MCP), 2b (voice) and 2c
(UI) plug in. The product spec is [PRODUCT.md](PRODUCT.md); commands and conventions are in
[AGENTS.md](../AGENTS.md).

## Components

```
browser (any device on the tailnet)
  │  https://<host>.ts.net:7443  (tailscale serve, foreground; TLS by Tailscale)
  ▼
vibe-center start  (one Bun process, binds 127.0.0.1:7880 only)
  ├─ Hono JSON API      /api/*      cookie auth, zod-validated bodies
  ├─ WebSocket channel  /ws         typed ServerEvents to every device
  ├─ SPA                /*          packages/web/dist  (dev: Vite on port+1 proxies /api,/ws)
  ├─ control socket     ~/.vibe-center/control.sock (0600)  ← `vibe-center link`
  ├─ SQLite             ~/.vibe-center/vibe-center.db  (WAL, FTS5)
  └─ one harness process per active agent, ACP over stdio
       claude-agent-acp (node) │ opencode acp │ custom command
```

Phase 2a adds the MCP gateway (an HTTP endpoint in the same process); phase 2b adds the Python
voice worker as a child process that calls back into the app.

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
  http/                   api.ts (core routes), middleware.ts, ws.ts, static.ts, origin.ts
  domain/                 chat.ts, turns.ts, agents.ts, harnesses.ts, presence.ts, errors.ts
  acp/                    the harness layer (below); knows nothing about storage or HTTP
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

## Data model (`db/migrations/0001_core.sql`)

| table | what |
|---|---|
| `harnesses` | presets (`claude-code`, `opencode`, seeded, builtin) and custom ones (command/args/env); cached `health` and `probe` (capabilities + config options = models, modes, …) |
| `agents` | name, description, avatar (emoji + color), system prompt, harness, model, other config option values (`options`), cwd, voice |
| `conversations` | one `dm` per agent; `active_session_id`; `last_read_seq` for unread |
| `sessions` | one row per ACP session; `acp_session_id` for resume after restarts; `ended` on "New session" |
| `turns` | one prompt and its outcome: `source` (user/voice/agent/event), `from_agent_id`, status, stop reason, error |
| `messages` | `seq` (global order) + `kind`: text, thought, tool_call, permission, plan, voice_transcript, session (divider), error; `data` JSON per kind (see `shared/src/domain.ts`) |
| `messages_fts` | FTS5 over message text; streaming messages are indexed once they stop streaming |
| `mcp_servers`, `agent_tools` | phase 2a: configured servers and per-agent tool enablement (`tool_name '*'` = whole server) |
| `memories` (+ FTS5) | phase 2a: `agent_id NULL` = shared |
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
  every session it creates or resumes; the servers go into `session/new|resume|load`. Phase 1
  uses `noMcp`.

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

### Phase 2a: MCP gateway and built-in tools

- **Implement `McpProvider`** (`acp/mcp.ts` documents the shape). It mints a per-session
  credential and returns one HTTP server (`{ type: "http", name: "vibe", url, headers }`) plus
  `allowedTools: ["mcp__vibe"]` so Claude Code doesn't ask for permission on app tools. Pass it
  in `createServices({ mcp })` (`services.ts`, shared) through `ServerOptions.mcp`
  (`server.ts`). OpenCode takes HTTP MCP servers in `session/new` too. Its tools appear as
  `vibe_<tool>`. Tool enablement is enforced in the gateway, not per harness.
- Mount the gateway endpoint in `server.ts` next to `/api` (e.g. `/mcp`). It authenticates by
  the per-session credential, **not** the device cookie.
- Built-in tools: memory (`memories` + `memories_fts` exist), conversation search
  (`MessageRepo.search` exists; add "surrounding messages"), agents (list, and send via
  `chat.prompt(targetId, { source: "agent", fromAgentId, text })`. To return immediately and
  deliver the reply later into the sender's session, use `done.then(r => chat.prompt(senderId,
  { source: "event", text: … }))`).
- Gateway tool calls should be visible in the UI. Publish your own events (`events/mcp.ts`).
  ACP `tool_call` messages already show what the harness reports.
- **Owns:** `packages/server/src/mcp/**` (new), `acp/mcp.ts`, `db/repos/{mcp-servers,memories}.ts`
  (new), new migrations, `shared/src/events/mcp.ts`, a new `shared/src/api-mcp.ts` (export it
  from `shared/src/index.ts`), routers under `packages/server/src/http/mcp-*.ts` using
  `middleware.ts`, web `routes/_app/settings/mcp.tsx`, `routes/_app/memories*.tsx`,
  `components/mcp/**`. **Shared:** `services.ts`, `server.ts`, `db/repos/index.ts`, the
  `SECTIONS` list in `routes/_app/settings.tsx`, `routeTree.gen.ts` (regenerate, don't merge).

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

## Known gaps (phase 1)

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
