# Vibe Center

A Slack for AI agents: each agent is a persona on a coding harness (Claude Code, OpenCode, any
ACP agent) you chat with in a DM; calls (voice) come next. Read before changing anything:
[docs/PRODUCT.md](docs/PRODUCT.md) (what we build) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
(how it's built, extension points, which phase owns which files).

## Commands

```sh
bun install
bun run check          # biome lint + strict tsc (all packages + e2e) + bun test. Must pass before every commit
bun run e2e            # builds the web app, runs Playwright against a throwaway server (port 7899; VC_E2E_PORT=… if taken)
bun run start          # vibe-center start: http://localhost:7880 + https://<host>.ts.net:7443
bun run dev            # same with Vite HMR (web on port+1, proxying /api and /ws)
bun packages/server/src/cli.ts start --local --data-dir /tmp/vc   # localhost only, scratch data
bun packages/server/src/cli.ts link [--data-dir …]               # fresh sign-in link
bun run format         # biome --write
bun run check:voice    # voice worker: ruff + pytest (services/voice/run.sh check; needs uv or nix)
```

- Sign in by opening the printed link (single use, 10 min). On NixOS, Playwright needs a nix
  chromium: `nix build nixpkgs#chromium -o .chromium` (the config picks it up).
- Data lives in `~/.vibe-center/` (`--data-dir` / `VIBE_CENTER_DATA_DIR`). Tests use temp dirs.
  Never point a test at the real one.
- `start` also starts the voice worker (`services/voice`, Python; first run syncs its venv);
  `--no-voice` skips it. `bun run e2e` includes a real voice call (`e2e/voice-call.spec.ts`,
  ~1 min, CPU speech unless `speech.sh up` ran; `VC_E2E_VOICE=0` skips it,
  `VC_E2E_VOICE_AGENT=claude` uses Claude Haiku instead of the fake agent). Parallel worktrees:
  pick another port with `VC_E2E_PORT`.
- GPU speech on km-pc: `services/speech-gpu/speech.sh up|status|down` (or Settings → Voice).
  Follow `.agents/skills/gpu-ml`: check `gpu status` for a local user, `speech.sh down`, then
  `gpu sleep` when done.
- Leave nothing running: stop servers with Ctrl+C or SIGTERM, which also stops harness
  processes, the voice worker, a GPU speech job and the `tailscale serve` entry. If a server
  was killed hard, the next `start` on that data dir reaps what it left (`<data>/run/`). Don't use `pkill -f <pattern>` from an agent shell;
  it can match the shell itself. Kill by PID.

## Layout

`packages/shared` (types, zod schemas, events), `packages/server` (CLI, Hono API, WS, domain,
ACP layer, SQLite), `packages/web` (Vite + React + TanStack Router/Query + shadcn/ui),
`e2e/` (Playwright), `services/voice` (the voice worker: Python 3.12, uv, ruff, pytest) and
`services/speech-gpu` (GPU STT/TTS servers for km-pc). `spikes/` and `prototype/` are reference
material from before v1; don't build on their code paths, port what you need.

## Conventions

- TypeScript strict, Biome formatting (2 spaces, double quotes, 110 cols). Pin exact dependency
  versions. Check the installed package's types or docs rather than assuming an API.
- Shared contracts first: domain types in `shared/src/domain.ts`, request schemas in
  `shared/src/api.ts` (or a new `api-<phase>.ts`), events in `shared/src/events/<phase>.ts`.
  The server validates every body with the zod schema; responses are typed with the shared types.
- PATCH schemas are built from default-free field sets (see `AgentPatchBody`). `.partial()` of a
  field with `.default()` would overwrite stored values.
- Prompts into agents go through `ChatService.prompt` only. ACP specifics stay in `acp/` and
  per-harness quirks in `acp/adapters/`. `acp/` never touches the DB or HTTP.
- Migrations: new `*.sql` file named `<YYYYMMDDHHmm>_<phase>_<what>.sql`; never edit applied ones.
- Web: server state only via TanStack Query (`lib/queries.ts`), live updates only via
  `lib/events.ts`, colours only via theme tokens. Add shadcn components with
  `bunx shadcn@4.23.0 add <name>` in `packages/web`.
- Tests: light and purposeful. ACP behaviour against `packages/server/test/fake-agent.ts` (add a
  keyword there for new scenarios); HTTP/WS flows in `test/server.test.ts`; one e2e per main flow.
- Generated `packages/web/src/routeTree.gen.ts` is committed. On merge conflicts, take either
  side and rebuild. Same for `bun.lock` (`bun install`).
- Commit in logical steps on `main`, never secrets. Every feature lands with evidence that it works.

## UI extension points (for phases 2a/2b slotting into the 2c layout)

The 2c UI build-out left marked seams rather than guessing at 2a's (MCP/tools) or 2b's (voice)
needs. 2a landed first and mounted its own `<AgentTools>` block under the form in
`routes/_app/agents/$agentId/edit.tsx` rather than inside `AgentForm` — a fine alternative to the
seam below, since tool enablement has its own save path per agent. 2b's seams are still open:

- **DM header** (`routes/_app/agents/$agentId/index.tsx`): a `{/* SEAM (2b): the call button
  mounts here */}` comment marks the spot among the header's action buttons (New session, Edit,
  Details), before the trailing "Agent details" toggle.
- **Details panel** (`components/details-panel.tsx`): a `{/* SEAM (2b): a "Voice" Section */}`
  comment sits between "Current session" and "Quick actions" — add a `<Section title="Voice">`
  (the `Section`/`Row` helpers in that file are already shared).
- **Agent editor** (`components/agent-form.tsx`): same pattern, a `FormSection` placed after
  "Harness and model" and before the submit buttons, reading/writing `agent.voice`.
- **Settings** (`routes/_app/settings.tsx`): add one line to the `SECTIONS` array and a new
  `routes/_app/settings/<yours>.tsx` route (see `general.tsx`/`harnesses.tsx` for the pattern:
  wrap content in the shared `<Section title="…">` from `settings.tsx`).
- **Sidebar/command palette/notifications are generic**, not per-agent — no seam needed there
  unless you're adding a new kind of global action (the ⌘K palette in
  `components/command-palette.tsx` is a plain list of `CommandItem`s to extend if useful, e.g. a
  "Start a call" action).
- Data layer: keep using `lib/queries.ts` (add your own hooks next to the existing ones) and
  `lib/events.ts`'s `applyEvent` (add cases for your own event types; unknown events are already
  ignored so this never breaks the others' tabs mid-rollout).
