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
```

- Sign in by opening the printed link (single use, 10 min). On NixOS, Playwright needs a nix
  chromium: `nix build nixpkgs#chromium -o .chromium` (the config picks it up).
- Data lives in `~/.vibe-center/` (`--data-dir` / `VIBE_CENTER_DATA_DIR`). Tests use temp dirs.
  Never point a test at the real one.
- Leave nothing running: stop servers with Ctrl+C or SIGTERM, which also stops harness
  processes and the `tailscale serve` entry. Don't use `pkill -f <pattern>` from an agent shell;
  it can match the shell itself. Kill by PID.

## Layout

`packages/shared` (types, zod schemas, events), `packages/server` (CLI, Hono API, WS, domain,
ACP layer, SQLite), `packages/web` (Vite + React + TanStack Router/Query + shadcn/ui),
`e2e/` (Playwright). `spikes/` and `prototype/` are reference material from before v1; don't
build on their code paths, port what you need. `services/` (voice worker, speech servers)
arrives in phase 2b.

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
