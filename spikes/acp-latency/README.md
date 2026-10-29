# ACP latency spike

Throwaway benchmark: how fast does an agent harness (Claude Code, OpenCode), driven over ACP,
answer one short conversational turn? Findings: [FINDINGS.md](FINDINGS.md).

## Files

- `bench.ts` – ACP client (`@agentclientprotocol/sdk` 2.1, `client().connect(ndJsonStream(...))`).
  Spawns one agent, `initialize` + `session/new` (cwd = fresh `scratch/<run>/`), runs the 8 turns
  from `configs.ts`, a barge-in (`session/cancel` 300 ms after the first text chunk, 5 s fallback)
  and one follow-up turn. Auto-approves permission requests. Writes `results/<config>-<ts>.json`
  with every `session/update` timestamped (epoch ms).
- `mcp-server.ts` – stdio MCP server (`@modelcontextprotocol/sdk`) passed via `mcpServers` in
  `session/new`: `list_sessions()` (static list) and `dispatch_task(session, instruction)`
  (returns `{"status":"dispatched","id":...}` at once). Logs invocations to `$TOOL_LOG`.
- `configs.ts` – persona prompt, turn script, configurations.
- `analyze.ts` – turns `results/*.json` into the markdown tables used in FINDINGS.md and
  `results/summary.json`.
- `claude-p.ts` – reference: cold one-shot `claude -p --output-format stream-json` timing.

## Run

```sh
bun install
bun bench.ts claude-haiku-a        # or claude-haiku-b, claude-haiku-a-nts, claude-sonnet-a/-b, opencode-a/-b
bun bench.ts opencode-a --probe --turns 1   # dump initialize/session/new responses
bun analyze.ts                      # tables for everything in results/
bun claude-p.ts 3                   # one-shot reference, 3 runs
```

Needs: `claude` login (`~/.claude/.credentials.json`, used by the adapter's bundled Claude Code
binary; no API key), `opencode` on PATH with a working model. The Claude adapter is run with
`node` (its shebang); the harness, MCP server and analysis run under Bun.

## Configurations

| name | agent | model | prompt / tools |
|---|---|---|---|
| claude-haiku-a | claude-agent-acp 0.99.0 | `haiku` (Haiku 5.5) | Claude Code preset + persona appended (`_meta.systemPrompt.append`) |
| claude-haiku-a-nts | " | " | as a + `ENABLE_TOOL_SEARCH=false` |
| claude-haiku-b | " | " | persona replaces system prompt, `tools: []`, tool search off, `settingSources: []`, `promptSuggestions: false`, thinking disabled, MCP tools pre-allowed |
| claude-sonnet-a / -b | " | `sonnet` (Sonnet 5.5) | as above |
| opencode-a | opencode 1.18.31 `opencode acp` | `opencode/deepseek-v4.1-flash-free` | default `build` agent, persona in scratch `AGENTS.md` |
| opencode-b | " | " | custom primary agent `voice` (opencode.json: prompt = persona; edit/bash/webfetch permission-denied — disabling tools breaks the free tier), selected via `session/set_config_option` |
