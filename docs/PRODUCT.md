# Vibe Center: product spec (v1)

The single source of truth for what v1 is. Agents building it read this first; when a decision
here turns out wrong, change it here (and say so in your report) rather than drifting silently.

## Vision

A Slack for your AI agents. You configure agents; each becomes a **persona** you talk to like a
colleague: text chat in a DM, or a **call** (real-time voice, like a phone call). Every agent runs
on an existing agent harness (Claude Code, OpenCode, any ACP agent) driven over **ACP**, so it has
the full capabilities of a modern harness, plus tools the app provides over **MCP**. Long term,
some agents are *managers* that steer other agents; v1 lays the ground for that.

Speech stays local (STT/TTS on the user's own machines); only the model behind the harness is
remote.

## How it runs

- One CLI is the single entry point: `vibe-center start` boots the server on `dev`, which serves
  the web app and owns everything else (agents, ACP sessions, MCP, voice processes, storage)
- the CLI prints a **link with a short-lived, single-use token** (≈10 min). Opening it exchanges
  the token for a long-lived, HttpOnly, Secure session cookie bound to that device. Nothing else
  can talk to the server: it controls agents on this machine. `vibe-center link` mints a fresh
  link while the server runs (talks to it over a local socket only the user can open)
- reachable across the user's devices on the tailnet over HTTPS (`tailscale serve`, as in
  `prototype/voice-loop/run.sh`), which the mic needs. Used from a MacBook browser first; the
  layout must also work on a phone
- a desktop app (Electrobun) is a later iteration, not v1

## Core concepts

- **Agent**: name, avatar (emoji + color), description, system prompt, **harness** (preset or
  custom), model and the other options the harness exposes over ACP, working directory, enabled
  tools, voice (TTS voice for calls)
- **Harness**: how an agent's process is launched and spoken to over ACP. Presets: **Claude
  Code** (`@agentclientprotocol/claude-agent-acp`) and **OpenCode** (`opencode acp`); plus
  **custom** (command, args, env). Settings show whether each is installed and working
- **DM**: the conversation with one agent: streamed replies, tool calls as compact expandable
  cards, permission requests as approve/deny cards, call transcripts inline. One long-running ACP
  session per DM; "New session" starts fresh (a divider in the DM) while history stays
  searchable
- **MCP server**: configured once in the app (stdio command or HTTP URL); its tools are
  discovered and listed. Per agent, tools are enabled or disabled, **grouped by server**.
  Built-in tools are on by default; a newly added server's tools are off until enabled for an
  agent; tools a server adds later follow its per-agent switch. Changes apply to running sessions
- **Built-in tools**: the app's own MCP server, enabled per agent like any other:
  - **memory**: save, search, list, update, delete. Scope: this agent's own memories or shared
    ones. Users can browse and edit memories in the UI
  - **conversation search**: search past messages (own DM by default, optionally all) and read
    the surrounding messages of a hit
  - **agents** (manager ground work): list agents, and send a message to another agent. Sending
    returns immediately; the reply arrives later as an event in the sender's session and both
    DMs show the exchange
- **Call**: a voice conversation with an agent from its DM header. Same ACP session as the text
  chat, so context carries over both ways; transcripts land in the DM as voice messages

## Key technical decisions

- **ACP for every harness**, via `@agentclientprotocol/sdk`. `spikes/acp-latency/` (FINDINGS.md,
  configs.ts) shows what works: Claude Code takes the persona through the ACP `systemPrompt`
  field (append mode, which claude-agent-acp advertises) and SDK options through
  `_meta.claudeCode.options` (`ENABLE_TOOL_SEARCH=false`, pre-allowed app MCP tools); OpenCode has
  no system-prompt capability and takes the persona as an `instructions` file passed in
  `OPENCODE_CONFIG_CONTENT`. The model and other options are ACP session config options for both
  (`session/set_config_option`). Hide these per-harness differences behind one adapter per preset.
  Models and other options come from the session's ACP config options: probe them, cache them,
  and offer them as dropdowns
- **One MCP gateway** owned by the app: each ACP session gets a single app MCP endpoint (with a
  per-session credential) that aggregates the agent's enabled tools from all configured servers
  plus the built-in ones. It enforces per-agent tool selection for any harness, and every tool
  call passes through it, so the UI can show it
- **Voice pipeline as separate managed processes**: the Python Pipecat voice worker
  (`services/voice`, grown from `prototype/voice-loop`) does transport, VAD, turn-taking,
  STT/TTS and latency hiding. It does *not* own the agent: its "LLM step" calls back into the main app, which routes it into the
  agent's ACP session and persists the transcript. STT/TTS default to the GPU servers on km-pc
  (`services/speech-gpu`, via `.agents/skills/gpu-ml`). Settings can point the worker and the
  STT/TTS services at URLs, so any of them can run on another machine. While in a call, prompts
  carry a voice-mode note (short spoken replies, no markdown). **No end-of-turn "mm-hmm"**:
  silence instead. Keep the filler cues around silent tool calls; the user liked them
- **Stack**: Bun + TypeScript for the CLI and server; web app as a Vite SPA with React,
  TanStack Router, Tailwind and shadcn/ui; SQLite (`bun:sqlite`) for storage, FTS5 for search;
  WebSocket for live updates (streaming, presence, unread state) so every open device stays in
  sync. Python + uv only for the voice worker and speech servers. Data lives in
  `~/.vibe-center/` (overridable)
- **Validation**: lint (Biome or equivalent), typecheck, unit/integration tests (`bun test`; ACP
  and MCP layers tested against real or fake processes), and a lightweight Playwright e2e suite
  for the main flows. Interactive checks with the `playwright-cli` skill. Every feature lands with
  evidence that it works; keep tests light and purposeful, never a goal in themselves

## UX: what makes it feel like a product

- Slack-like layout: sidebar with agents (avatar, **presence**: idle / thinking / working / in
  call / error, **unread** badge), DM in the middle, details panel (agent info, current session,
  tools) on demand. Dark and light theme. Keyboard first: ⌘K switcher and global message search
- streaming replies with markdown and code highlighting; a stop button that cancels the turn;
  tool calls and permission requests inline; plans and "thinking" collapsed by default
- creating an agent is quick: a template picker ("Coding agent", "Manager", "Blank") pre-fills
  prompt, tools and harness; everything stays editable later
- clear failure states: harness not installed, auth missing, voice services offline, MCP server
  failing. Each points to the setting that fixes it
- browser notification when an agent finishes or needs approval while its DM is not in view
- settings: General (server, tailnet/https, data dir), Devices (connected sessions, revoke),
  Harnesses, MCP servers, Voice (worker location, STT/TTS URLs, cues), Appearance

## Out of scope for v1

Desktop app, multi-user accounts, group channels with several agents, T3 Code integration,
cloud sync. Leave seams for them; build none of them.
