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
- `start` rebuilds the web app when its sources are newer than the last build (`--no-build` skips
  the check); `--dev` always uses Vite and never needs this.
- Data lives in `~/.vibe-center/` (`--data-dir` / `VIBE_CENTER_DATA_DIR`). Tests use temp dirs.
  Never point a test at the real one.
- `start` also starts the voice worker (`services/voice`, Python; first run syncs its venv);
  `--no-voice` skips it. `bun run e2e` includes a real voice call (`e2e/voice-call.spec.ts`,
  ~1 min, CPU speech unless `speech.sh up` ran; `VC_E2E_VOICE=0` skips it,
  `VC_E2E_VOICE_AGENT=claude` uses Claude Haiku instead of the fake agent). Parallel worktrees:
  pick another port with `VC_E2E_PORT`.
- GPU speech on the GPU host: `services/speech-gpu/speech.sh up|status|down` (or Settings → Voice).
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
`services/speech-gpu` (GPU STT/TTS servers for the GPU host). `spikes/` and `prototype/` are reference
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
  `lib/events.ts`, colours only via theme tokens (`index.css`; the design is "Nocturne Ash",
  design/explorations/README.md §6b: dark first, one ivory accent, colour only for presence and
  approvals). Add shadcn components with `bunx shadcn@4.23.0 add <name>` in `packages/web`, then
  restyle them to the tokens like the ones in `components/ui/`. Screens that differ between
  desktop and phone (not just hide) switch on `useIsMobile()`. `bun scripts/screenshots.ts`
  renders every screen to `docs/screenshots/` for a visual check.
- Tests: light and purposeful. ACP behaviour against `packages/server/test/fake-agent.ts` (add a
  keyword there for new scenarios); HTTP/WS flows in `test/server.test.ts`; one e2e per main flow.
- Generated `packages/web/src/routeTree.gen.ts` is committed. On merge conflicts, take either
  side and rebuild. Same for `bun.lock` (`bun install`).
- Work on a branch and open a PR against `main`; PRs are squash-merged and the PR title becomes the
  commit, so it must be a Conventional Commit (`feat(web): …`, `fix(voice): …`, `docs: …`; checked
  by `pr-title.yml`). `feat`/`fix`/`perf` merges cut a `-next` pre-release (docs/RELEASING.md).
  Commit in logical steps on the branch, never secrets. Every feature lands with evidence that it works.

## UI extension points

2a (MCP/tools) and 2b (voice) have both landed in the 2c layout: the DM header's call button
(`routes/_app/agents/$agentId/index.tsx`), the details panel's Voice section
(`components/details-panel.tsx`), the agent editor's Voice `FormSection`
(`components/agent-form.tsx`), Settings → Voice, and 2a's own `<AgentTools>` block under the form
in `routes/_app/agents/$agentId/edit.tsx` (a fine alternative to a seam inside `AgentForm`, since
tool enablement has its own save path per agent) are all in place. For a future phase that needs
its own slot:

- **Sidebar/command palette/notifications are generic**, not per-agent — no seam needed there
  unless you're adding a new kind of global action (the ⌘K palette in
  `components/command-palette.tsx` is a plain list of `CommandItem`s to extend if useful). The
  sidebar's bottom links (`BOTTOM` in `components/sidebar.tsx`) and the phone tab bar (`TABS` in
  `components/mobile-nav.tsx`) are the two lists to extend for a new top-level page; give the page
  a `<PageHeader>` so it gets the phone's back chevron.
- **Settings**: add one line to the `SECTIONS` array in `routes/_app/settings.tsx` and a new
  `routes/_app/settings/<yours>.tsx` route (see `general.tsx`/`harnesses.tsx` for the pattern:
  wrap content in the shared `<Section title="…">` and `<Card>` from `settings.tsx`).
- **Details panel**: append a `<Section title="…">` (the `Section`/`Row` helpers in
  `components/details-panel.tsx` are shared).
- **Agent editor**: append a `FormSection` in `components/agent-form.tsx`, before the submit
  buttons.
- Data layer: keep using `lib/queries.ts` (add your own hooks next to the existing ones) and
  `lib/events.ts`'s `applyEvent` (add cases for your own event types; unknown events are already
  ignored so this never breaks the others' tabs mid-rollout).
