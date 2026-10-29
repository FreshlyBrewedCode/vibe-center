# Prior Art: Voice Manager Agents for Orchestrating Coding-Agent Sessions

Research date: 2026-10-29. All stars/dates/licenses below were checked directly via `gh api repos/<org>/<repo>` (GitHub REST API) or by fetching the live GitHub/docs page on 2026-10-29, unless marked "unverified." Star counts are approximate snapshots as of this date and will drift.

## Top-line summary

- There is **no OSS project today whose entire purpose is "voice manager agent that orchestrates other coding-agent *sessions*"** (i.e., spawn/steer/summarize N parallel Claude Code / OpenCode / Codex threads purely by voice, phone-call style). That specific shape is genuinely greenfield.
- The closest prior art is **Paseo** (`getpaseo/paseo`, ~22.4k stars, Apache-2.0-ish license) — a multi-agent orchestration IDE with first-class, local-first "Voice Mode" that launches a *hidden orchestration agent session* (Claude/Codex/OpenCode) which can itself launch and talk to other agent sessions, and **Qwen Audio Agent** (`QwenAudio/qwen-audio-agent`, ~3.1k stars, Apache-2.0) — a dedicated "realtime voice runtime that keeps Agents talking, working, and present," purpose-built around ACP with explicit async task delegation, multi-task admission queues, and spoken status callbacks ("It's ready").
- Most of the ~20 "talk to Claude Code" MCP servers found are small, single-maintainer, single-machine push-to-talk tools (half-duplex: record → transcribe → inject as one text turn → speak reply). Very few implement true full-duplex barge-in.
- ACP (Agent Client Protocol) is maturing fast as the interoperability layer under these tools — Claude Code, Codex CLI, and OpenCode all now have ACP adapters/native support — but a **standalone voice↔ACP client is still mostly aspirational**: the one concrete "voice over ACP" proposal found (Chumby) is an open, unimplemented GitHub issue, not shipped code. Qwen Audio Agent is the exception: it is a real, shipped, actively maintained voice-to-ACP gateway.
- Both Anthropic's Claude Agent SDK and OpenCode's HTTP server already provide the primitives a voice manager needs: streaming message generators, explicit interrupt/abort calls, and session resume/fork/list APIs. The gap is not in the agent-harness SDKs — it's in the voice-orchestration layer that sits above multiple concurrent sessions and does turn-taking/barge-in across them.

---

## 1. OSS projects for talking to Claude Code / OpenCode / Codex CLI / Gemini CLI / Aider by voice

### 1a. mbailey/voicemode ("VoiceMode")

- GitHub: https://github.com/mbailey/voicemode (checked 2026-10-29)
- Stars: ~1,428 (checked 2026-10-29)
- Last push: 2026-10-29 (active; created 2025-06-08). Not stale.
- License: MIT
- What it does: An MCP server, installable as a Claude Code plugin (`claude plugin install voicemode@voicemode`) or standalone (`claude mcp add ... voicemode-mcp-launcher`), that gives Claude Code (or any MCP-capable agent/host) a `converse` tool for spoken back-and-forth. Push-to-talk / silence-detection style turns, not full duplex.
- Architecture: STT/TTS via OpenAI API by default (cloud), with optional 100%-local fallback using **Whisper.cpp** (STT) and **Kokoro** (TTS) — "same API as OpenAI, so VoiceMode switches seamlessly between them" (README). LLM is whatever MCP host is driving it (Claude Code).
- Integration mechanism: MCP server (stdio), exposes `mcp__voicemode__converse` / `mcp__voicemode__service` tools that Claude Code calls as ordinary tool calls — i.e., it's Claude Code's own agent loop calling out to a voice tool, not a separate process steering Claude Code.
- Note: there is a separate near-identical `mcp-research/mbailey__voice-mcp` mirror repo; treat `mbailey/voicemode` as canonical.

### 1b. Other small Claude Code voice MCP servers (all discovered via GitHub search, all verified live via `gh api`)

| Project | Stars | Last push | License | Description | Stack / integration |
|---|---|---|---|---|---|
| [tuansondinh/agent-voice-mcp](https://github.com/tuansondinh/agent-voice-mcp) | 2 | 2026-03-26 ⚠ STALE (~7 mo) | MIT | Voice MCP server for Claude Code/Codex, hands-free voice I/O, macOS | TTS + Whisper, MCP server |
| [alamparelli/mcp-claude-say](https://github.com/alamparelli/mcp-claude-say) | 7 | 2026-01-31 ⚠ STALE (~9 mo) | MIT | macOS-only TTS (native speech synthesis) + STT (Parakeet MLX) | MCP server |
| [shreyaskarnik/voice-mcp](https://github.com/shreyaskarnik/voice-mcp) | 16 | 2026-02-10 ⚠ STALE (~9 mo) | Apache-2.0 | Bidirectional `listen()`/`speak()` tools, Apple-Silicon-local via mlx-audio | MCP server, fully local |
| [jochiang/voice-mcp](https://github.com/jochiang/voice-mcp) | 2 | 2025-12-29 ⚠ STALE (~10 mo) | none found | Local Whisper (STT) + Supertonic (TTS) | MCP server |
| [guillaume-gonano/claude-voice-mcp](https://github.com/guillaume-gonano/claude-voice-mcp) | 0 | 2026-10-28 (fresh, but brand-new/unproven) | MIT | Bridges Claude mobile app's own voice mode to a headless Claude Code on your Mac via remote MCP connector (OAuth + Cloudflare Tunnel) | Remote MCP bridge, reuses Claude app's STT/TTS |
| [roykollensvendsen/claude-voice](https://github.com/roykollensvendsen/claude-voice) | 4 | 2026-10-09 (fresh) | GPL-3.0 | "MCP bridge for driving local Claude Code sessions by voice" from phone | MCP bridge |
| [Connected-Mate/gptvoice](https://github.com/Connected-Mate/gptvoice) | 0 | 2026-10-06 (fresh, new) | MIT | Voice studio for Claude Code/any MCP agent reusing a ChatGPT sign-in (no API key) | MCP server + skill + CLI |
| [codexstar69/pi-listen](https://github.com/codexstar69/pi-listen) | 81 | 2026-10-27 (active) | MIT | Hold-to-talk voice input for **Pi CLI**, Deepgram streaming STT, live transcription | CLI wrapper, Deepgram cloud STT |
| [dragfly/dictare](https://github.com/dragfly/dictare) | 17 | 2026-09-17 (active) | MIT | "Voice interaction layer for AI coding agents and beyond," defines an open protocol **OpenVIP**, 100% local | Local-only voice protocol, agent-agnostic |
| [dixonSolutions/AgentVoice](https://github.com/dixonSolutions/AgentVoice) | 4 | 2026-10-21 (active) | MIT | Self-hosted voice bridge for Cursor, Codex, and Claude Code; phone-to-desktop via Tailscale or other transports | Self-hosted bridge |
| [dotdevdotdev/agentwire-dev](https://github.com/dotdevdotdev/agentwire-dev) ("AgentWire") | 23 | 2026-10-29 (active) | Apache-2.0 | "Self-hosted, keyboard-driven cockpit for running a whole fleet of Claude Code agents at once" — worktrees, command palette, scheduler, **and voice** as one layer among several | Multi-agent cockpit + voice layer, self-hosted, no telemetry |
| [CakeCrusher/full_duplex_code](https://github.com/CakeCrusher/full_duplex_code) | 22 | 2026-10-29 (active) | none found | "Talk to Claude Code while it works" — explicitly **full-duplex** voice companion powered by "GPT Live 1" | Full-duplex voice, cloud realtime model |
| [dev-sseul/linkgravity](https://github.com/dev-sseul/linkgravity) | 9 | 2026-10-06 (active) | MIT | Messenger interface for Google's **Antigravity** agent with voice control + interactive CLI tool approvals | Messenger/voice bridge |
| [prashanthgit19/homie](https://github.com/prashanthgit19/homie) | 5 | 2026-10-23 (active) | MIT | "Personality layer" (chat-voice) for coding agents — same underlying agent, different spoken persona | Thin TTS personality wrapper |
| [tonyyont/peon-ping](https://github.com/tonyyont/peon-ping) / mirror [PeonPing/peon-ping](https://github.com/PeonPing/peon-ping) | ~5,095 | 2026-10-19 (active) | MIT | Warcraft III Peon-style audio *notifications* for Claude Code/Codex/any agent — one-way status sounds, not a voice interface for talking back | Notification hook, TTS one-liners only |

Note on peon-ping: by far the highest-starred item in this table, but it is a **notification sound/TTS hook**, not a conversational voice interface — it tells you when Claude is done, it doesn't let you talk to or steer Claude. Included for completeness because it's frequently conflated with "voice for Claude Code" in search results.

### 1c. Official Anthropic voice mode (not Claude-Code-specific, but relevant)

- Support article: https://support.claude.com/en/articles/11101966-using-voice-mode (fetched 2026-10-29)
- Scope: Claude's own mobile/desktop/web apps have a "Voice mode," hands-free (auto turn-detection) or push-to-talk, with the ability to interrupt Claude mid-response by speaking again — i.e. basic barge-in, not demonstrated full-duplex overlap. In Anthropic's newer unified app experience, the doc states "voice mode works in any conversation, including ones where Claude is working on a task," meaning Claude's own first-party app is moving toward "talk to Claude while it codes," but this is a closed, hosted product feature, not an adapter you point at your own local Claude Code CLI session, and STT/TTS implementation details are not published.

### 1d. Pipecat / LiveKit Agents demos specifically wired to coding agents

- Pipecat: https://github.com/pipecat-ai/pipecat — ~16,913 stars, Apache(BSD-2-Clause license per repo metadata), pushed 2026-10-29 (very active). It is a generic, cloud/local-hybrid voice-agent orchestration framework (VAD, STT/LLM/TTS pipeline, interruption handling built in) with providers for Deepgram, ElevenLabs, OpenAI, etc. No first-party "drives Claude Code" demo was found in the main repo; it's a toolkit people build coding-agent voice bridges *on top of* (e.g., `CakeCrusher/full_duplex_code` and several `heyski.io`/Show-HN tools reference Pipecat-style realtime patterns in their write-ups) rather than itself shipping a Claude Code/OpenCode integration.
- LiveKit Agents: https://github.com/livekit/agents — ~14,996 stars, Apache-2.0, pushed 2026-10-29 (very active). Same situation: a general realtime-voice-agent framework (telephony/WebRTC transport, STT/TTS/LLM plugin architecture, built-in interruption/VAD) with no first-party example that drives an external coding-agent harness like Claude Code's CLI or OpenCode. Treat both as **infrastructure a voice-manager-agent builder would use**, not as existing coding-agent-voice products themselves.

### 1e. Aider / Gemini CLI specifically

- No maintained, actively-starred voice wrapper specifically for **Aider** or **Gemini CLI** was found in this search (several generic "voice for AI coding agents" projects claim broad agent support, e.g. dictare, AgentVoice, but their READMEs emphasize Claude Code/Cursor/Codex, not Aider/Gemini CLI specifically). Gemini CLI's relevance here is mostly as an ACP-native backend (see §2) rather than as a target of a dedicated voice wrapper.

---

## 2. Voice clients for ACP (Agent Client Protocol)

- Spec/site: https://agentclientprotocol.com (fetched 2026-10-29). ACP standardizes JSON-RPC 2.0 over stdio between an editor/client and an agent; "full support for remote agents is a work in progress." The fetched page itself makes **no mention of voice** at all — voice is entirely absent from the spec's own documentation.
- Reference repo: https://github.com/agentclientprotocol/agent-client-protocol — ~4,536 stars, Apache-2.0, pushed 2026-10-29 (active).

### Current ACP adapter status for the four target harnesses

| Harness | ACP status | Source |
|---|---|---|
| Claude Code | **External adapter**, not native: `zed-industries/claude-code-acp` ("ACP adapter for the Claude Agent SDK" / npm `@agentclientprotocol/claude-agent-acp`) — ~2,706 stars, Apache-2.0, pushed 2026-10-29. Wraps the Claude Agent SDK to speak ACP; supports tool calls/permissions, subagent sessions as child ACP sessions, `session/cancel` interrupting foreground children, etc. | https://github.com/zed-industries/claude-code-acp (checked 2026-10-29) |
| OpenCode | **Native**: `opencode acp` starts OpenCode itself as an ACP-compatible subprocess over stdio; editor is the client, OpenCode is the agent. Supported by Zed, JetBrains IDEs, Neovim (Avante.nvim, CodeCompanion.nvim). Some slash commands (`/undo`, `/redo`) unsupported in ACP mode. | https://opencode.ai/docs/acp/ (fetched 2026-10-29) |
| Codex CLI | **External adapter**, actively consolidating: originally `zed-industries/codex-acp` (now **archived**, last push 2026-07-22, 872 stars ⚠ STALE/ARCHIVED) — development moved to the canonical `agentclientprotocol/codex-acp` (~497 stars, pushed 2026-10-29, active), which wraps the new "Codex App Server" and implements the full ACP lifecycle (`initialize`, `authenticate`, `session/new`, `session/load`, `session/prompt`, `session/cancel`). | https://github.com/agentclientprotocol/codex-acp, https://github.com/zed-industries/codex-acp (both checked 2026-10-29) |
| Gemini CLI | Native ACP support cited repeatedly in secondary sources (e.g., comparisons to "Codex CLI, similar to Gemini CLI's ACP mode") — **not independently verified against Gemini CLI's own repo in this pass**; treat as plausible-but-unverified pending a direct check of `google-gemini/gemini-cli`. | unverified |

### Is there a voice-driven ACP client anywhere?

- **Qwen Audio Agent** (`QwenAudio/qwen-audio-agent`) is the one real, shipped example — see full write-up in §4/§5 below. It is explicitly built "under the ACP architecture" (its own v0.9.0 changelog note) and lists native-ACP and adapter-based ACP backends including **OpenCode (native ACP)** and **Claude Code (external ACP adapter)**.
- **Chumby voice interface proposal**: https://github.com/johnmerchant/neochumby/issues/43, open issue dated 2026 (checked 2026-10-29), titled "voice: talk to a coding agent through a USB microphone, over ACP." This is a **design proposal only** — it explicitly lays out an architecture (Chumby touchscreen push-to-talk → USB mic → companion daemon running local whisper.cpp STT → ACP client that spawns Claude Code's ACP adapter or Gemini CLI as a subprocess) but the issue itself says "none of this works unless..." and ends with "Before any code, [test USB audio on the Chumby's 2.6.16 kernel]." Treat this as evidence of intent/design thinking in the community, not working code.
- A general-purpose VS Code ACP client, `formulahendry/vscode-acp` (~407 stars, pushed 2026-05-16, checked 2026-10-29), connects any ACP agent (Claude, Codex, Copilot, Qwen, Gemini, OpenCode, Kiro, and more) to VS Code, but is a text editor UI, not voice.
- A claimed "VACP" project ("voice control for OpenCode/KiloCode over TCP") surfaced in an initial web-search synthesis but **could not be found as an actual GitHub repository** on direct search — flagging as **unverified / likely not a real distinct project** (possibly a search-engine hallucination or a very obscure/unindexed repo). Do not cite it as real prior art.

---

## 3. SDK/server primitives for streaming, interruption, and session management

### 3a. Claude Agent SDK (TypeScript + Python)

Source: https://code.claude.com/docs/en/agent-sdk/overview (fetched 2026-10-29, canonical docs host as of this date — docs.claude.com → platform.claude.com → code.claude.com redirect chain), plus https://code.claude.com/docs/en/agent-sdk/sessions.md and https://code.claude.com/docs/en/agent-sdk/typescript.md (both fetched 2026-10-29).

- **Streaming**: `query()` returns a `Query` object that **extends `AsyncGenerator<SDKMessage, void>`** — consume with `for await (const message of query({...}))`. This is the baseline low-latency streaming primitive a voice loop needs for incremental TTS synthesis of partial output.
- **Interruption / barge-in**: three mechanisms, all documented:
  1. `interrupt(): Promise<SDKControlInterruptResponse | undefined>` on the `Query` object — "Available only in streaming input mode." Returns `still_queued` (UUIDs of pending user messages) and optionally `cancelled` if `cancel_queued: true` was set. Available on Claude Code CLI v2.1.205+; returns `undefined` on earlier versions.
  2. `abortController: AbortController` passed in `Options` — standard JS abort pattern (`controller.abort()`).
  3. `close(): void` on the `Query` — forcefully terminates the query and the underlying Claude Code process.
  - These three give a voice manager exactly the primitives needed for barge-in: soft interrupt-and-resume (`interrupt()`), hard cancel (`abortController`/`close()`).
- **Session/thread management**: documented at https://code.claude.com/docs/en/agent-sdk/sessions.md.
  - **Continue**: `continue: true` (TS) / `continue_conversation=True` (Python) resumes the most recent session in the cwd, no ID tracking.
  - **Resume**: pass a captured `session_id` to `resume` (both langs) to pick up a specific past session — necessary for a voice manager juggling multiple named agent threads.
  - **Fork**: `forkSession: true` (TS) / `fork_session=True` (Python) branches a session's history into a new session ID without mutating the original — useful for a voice manager that wants to let a user explore an alternative without losing the main thread.
  - Python's `ClaudeSDKClient` holds session state across multiple `client.query()` calls automatically (multi-turn chat in one process) via an async context manager; TypeScript instead uses `continue: true` per-call (the experimental V2 `createSession()`/`send`/`stream` API was **removed** in TS Agent SDK 0.3.142 — note for anyone reading older blog posts referencing it).
  - Both SDKs expose `listSessions()`/`list_sessions()`, `getSessionMessages()`/`get_session_messages()`, `getSessionInfo()`/`get_session_info()`, `renameSession()`/`rename_session()`, `tagSession()`/`tag_session()` for building custom session pickers — exactly the primitives a voice manager needs to answer "what threads do I have running" and give them human-readable spoken names.
  - Sessions are stored as `.jsonl` under `~/.claude/projects/<encoded-cwd>/`; cross-host resume requires a `SessionStore` adapter or manually shipping the transcript file.

### 3b. OpenCode HTTP server (`opencode serve`)

Source: https://opencode.ai/docs/server/ (fetched 2026-10-29).

- **Streaming**: `GET /global/event` (global SSE event stream) and `GET /event` (per-connection SSE stream of bus events).
- **Interruption**: `POST /session/:id/abort` — "Abort a running session," returns a boolean. This is OpenCode's direct equivalent of Claude Agent SDK's `interrupt()`/`abortController`.
- **Session management**: full CRUD plus hierarchy —
  - `GET /session` (list), `POST /session` (create, with optional parent ID + title), `GET /session/:id` (read), `PATCH /session/:id` (update e.g. title), `DELETE /session/:id` (delete)
  - `GET /session/:id/children` (nested/branching conversations)
  - `POST /session/:id/fork` (branch an existing session at a message point)
  - This parent/child session hierarchy is directly useful for a voice manager that wants a "manager" top-level session spawning per-task "worker" sessions — conceptually close to what Qwen Audio Agent and Paseo build on top of ACP/their own orchestration runtime.

### 3c. Implication for a voice manager agent

Both target harnesses already expose everything needed for a voice loop with barge-in: streaming generators + an abort/interrupt call + addressable, listable, resumable sessions. **The missing piece is entirely in the voice-orchestration layer**: turn-taking across multiple concurrent agent sessions, deciding when to speak a status update unprompted, and mapping "stop" or "wait, back up" utterances onto the right session's interrupt call. None of the SDKs do this for you.

---

## 4. Multi-agent orchestration dashboards / "agent manager" tools

| Project | Stars | Last push | License | Voice? | Notes |
|---|---|---|---|---|---|
| [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) | ~28,502 | 2026-10-29 (active) | Apache-2.0 | No voice found | Kanban-style dashboard for Claude Code/Codex/any coding agent; pure text/UI orchestration. |
| [slopus/happy](https://github.com/slopus/happy) ("Happy Coder") | ~24,397 | 2026-10-29 (active) | MIT | **Yes — "Built-in voice agent with customizable prompts"** per its own comparison docs (https://happy.engineering/docs/comparisons/alternatives/, fetched 2026-10-29). Orchestrates Claude, Codex, and Grok in one app, spawns/controls multiple Claude Code instances in parallel, phone + desktop. Exact STT/TTS stack **not specified** in the fetched page — flagged as under-documented rather than fabricated. | |
| [getpaseo/paseo](https://github.com/getpaseo/paseo) | ~22,403 | 2026-10-29 (active) | Apache 2.0 (own LICENSE file, "NOASSERTION" per GitHub's auto-detector but text is Apache-2.0 + copyright notice) | **Yes, extensively** — see detailed writeup below. | **Closest single match to a "voice manager agent" among the dashboards.** |
| [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad) ("Claude Squad") | ~8,696 | 2026-08-20 ⚠ STALE (~2.3 mo as of check, borderline) | AGPL-3.0 | No voice found | TUI for managing multiple terminal agent sessions (Claude Code, Codex, OpenCode, Amp) in separate tmux/git-worktree sandboxes; pure text/TUI. |
| [stravu/crystal](https://github.com/stravu/crystal) | ~3,130 | 2026-02-26 ⚠ STALE (~8 mo) | MIT | No voice found | Desktop app running multiple Codex/Claude Code sessions in parallel git worktrees. **Project has been rebranded/succeeded by Nimbalyst** (README: "Crystal is now Nimbalyst") — treat Crystal itself as effectively discontinued. |
| [nimbalyst/nimbalyst](https://github.com/nimbalyst/nimbalyst) (Crystal's successor) | ~1,996 | 2026-10-29 (active) | MIT | No voice found in README | "Open-source visual workspace for Claude Code, Codex, and OpenCode" — markdown/mockup/diagram-based visual editing of parallel agent work, not a voice tool. |
| [omnara-ai/omnara](https://github.com/omnara-ai/omnara) | ~3,311 (3.3k per repo page) | 2026-10-29 (active) | Apache-2.0 | **Claimed "Voice Coding Mode"** on marketing/app-store pages (https://apps.apple.com/.../omnara...) and third-party listings, described as "natural two-way voice... perfect for coding while commuting or walking." **Could not confirm the mechanism (STT/TTS stack, local vs cloud) from the public GitHub repo/README or MCP server docs** — the OSS repo's own README/docs describe Omnara mainly as an MCP server (`https://app.omnara.com/mcp`) + mobile dashboard for monitoring/approving Claude Code/Codex sessions remotely; the voice feature appears to live primarily in the closed mobile app layer. Flagging this as **partially unverified**: real feature, mechanism not confirmed via primary OSS source. | |
| "Conductor" | — | — | — | — | Could not find a canonical open-source GitHub repo named `conductor` matching "Claude Code manager" in this search (one unrelated throwaway sandbox repo found, no real project). If the user means the commercial macOS app conductor.build, note it is **not open source** and out of scope for this inventory; **unverified/not found** as OSS. |

### Deep dive: getpaseo/paseo's Voice Mode (closest OSS match to "voice manager agent")

Source: https://github.com/getpaseo/paseo, `public-docs/voice.md` (fetched via GitHub contents API, 2026-10-29).

- "Paseo has first-class voice support for dictation and voice mode conversations with your coding environment." "Voice is local-first."
- Architecture per its own docs:
  - **Local speech runtime**: ONNX models on CPU by default — STT default `parakeet-tdt-0.6b-v2-int8` (English-only; multilingual options `parakeet-tdt-0.6b-v3-int8` or `whisper-base` available), TTS default `kokoro-en-v0_19`.
  - **Cloud option**: swap to OpenAI (`gpt-4o-transcribe` / `gpt-4o-mini-transcribe` for STT, `tts-1` for TTS) via config.
  - **Voice LLM orchestration**: "a hidden agent session using your configured provider (`claude`, `codex`, or `opencode`)" — i.e. voice mode doesn't call a raw LLM API; it drives one of the exact three target harnesses in this research brief, through a real agent session.
  - **Tooling path**: "MCP stdio bridge for voice tools and agent control" — the hidden voice-orchestrator session reaches the actual coding-agent sessions via MCP.
  - Explicit operational warning in the docs: "Voice mode can launch and control agents. Treat voice prompts with the same care as direct agent instructions" — confirming it really does let you spawn/steer other agent sessions by voice, not just dictate text.
- Paseo's base product (independent of voice) already supports exactly the "manage threads" half of the brief: "Built-in orchestration: Agents in Paseo can create worktrees, launch other agents, and talk to them, across providers" (README) across Claude Code, Codex, Copilot, OpenCode, Pi, Antigravity, Muse Code.
- Gap vs. a true "voice manager agent" / phone-call UX: Paseo's voice mode is described as "dictation and voice mode conversations," i.e., still oriented around a desktop/mobile app session where you talk to one hidden orchestrator session; it is not architected around async, interruptible, multi-session status narration the way Qwen Audio Agent's task/queue model is (see §5). No explicit barge-in/full-duplex claim found in its docs.

---

## 5. Blog posts / HN threads on building voice control for coding agents — verified projects and learnings

Searched via `hn.algolia.com` API (`voice coding agent`, `voice claude code`) and WebSearch; every project named below was cross-checked against its actual GitHub repo via `gh api` before being cited.

### Verified Show-HN / blog projects (all checked 2026-10-29)

| Project | HN / post | GitHub | Stars | Last push | License |
|---|---|---|---|---|---|
| Full-duplex Claude Code voice companion | [HN](https://news.ycombinator.com/item?id=49899237) | [CakeCrusher/full_duplex_code](https://github.com/CakeCrusher/full_duplex_code) | 22 | 2026-10-29 | none found |
| AgentWire — voice-control local/remote agents via tmux cockpit | [HN #1](https://news.ycombinator.com/item?id=46968740), [HN #2](https://news.ycombinator.com/item?id=46974968) | [dotdevdotdev/agentwire-dev](https://github.com/dotdevdotdev/agentwire-dev) | 23 | 2026-10-29 | Apache-2.0 |
| Dictare — 100% local voice layer, OpenVIP protocol | [HN](https://news.ycombinator.com/item?id=47397427) | [dragfly/dictare](https://github.com/dragfly/dictare) | 17 | 2026-09-17 | MIT |
| Agent Voice (dixonSolutions) | [HN](https://news.ycombinator.com/item?id=49373051) | [dixonSolutions/AgentVoice](https://github.com/dixonSolutions/AgentVoice) | 4 | 2026-10-21 | MIT |
| Homie — personality/voice layer | [HN](https://news.ycombinator.com/item?id=50071939) | [prashanthgit19/homie](https://github.com/prashanthgit19/homie) | 5 | 2026-10-23 | MIT |
| LinkGravity — voice + messenger bridge for Antigravity | [HN](https://news.ycombinator.com/item?id=49297348) | [dev-sseul/linkgravity](https://github.com/dev-sseul/linkgravity) | 9 | 2026-10-06 | MIT |
| pi-listen — hold-to-talk for Pi CLI (Deepgram) | [HN](https://news.ycombinator.com/item?id=48190992) | [codexstar69/pi-listen](https://github.com/codexstar69/pi-listen) | 81 | 2026-10-27 | MIT |
| Paseo — orchestrate multiple coding agents, open-source | [HN #1](https://news.ycombinator.com/item?id=47530027), [#2](https://news.ycombinator.com/item?id=47575827), [#3](https://news.ycombinator.com/item?id=47529963) | [getpaseo/paseo](https://github.com/getpaseo/paseo) | 22,403 | 2026-10-29 | Apache-2.0 |

Several other HN-discovered names (DashVox, 1-800-CODER, PUNK, Nura Dev, PromptPaste, Riffn, Luke/tryluke.dev) returned **no matching public GitHub repository** on direct search and appear to be closed-source/commercial apps or pre-launch landing pages — these are **not included as verified OSS prior art**; listed here only so they aren't silently rediscovered and mistaken for something more substantial:
- Show HN: DashVox (dashvox.ai) — no GitHub repo found, unverified.
- Show HN: 1-800-CODER (call-to-code macOS app) — no GitHub repo found, unverified.
- Show HN: PUNK (punkcode.rocks) — no GitHub repo found, unverified.
- Show HN: Nura Dev (iOS app) — no GitHub repo found, unverified.
- Show HN: PromptPaste — no GitHub repo found, unverified.
- Show HN: Riffn (riffn.io) — no GitHub repo found, unverified.
- Show HN: Luke (tryluke.dev, "voice planning for coding agents") — no GitHub repo found, unverified.
- "Ski" voice coding for Claude Code/Codex (heyski.io), referenced in 3 separate HN threads (points 15, 4, 4) — no GitHub repo found under an obvious name; appears to be a commercial/closed product, unverified as OSS.

### UX / latency learnings pulled from verified sources

1. **"Voice is a turn-taking problem, not a transcription problem."** From the HN "Show HN: I built a sub-500ms latency voice agent from scratch" thread (https://news.ycombinator.com/item?id=47224295, fetched 2026-10-29) — general voice-agent build (not coding-agent-specific, but directly applicable):
   - Achieved ~400ms end-to-end latency (speech → first agent response).
   - Stack: **Deepgram Flux** (STT, with built-in semantic end-of-turn detection) → **Groq** (LLM inference, ~80ms time-to-first-token, described as "the single biggest win") → **ElevenLabs** (TTS, warm websocket pools saving ~300ms).
   - Geographic colocation of infra mattered more than prompt-level optimization.
   - Semantic end-of-turn detection (not raw VAD silence thresholds) is what makes barge-in feel clean; the entire interaction reduces to one core state machine: speaking vs. listening, with instant cancel-on-barge-in and respond-on-turn-end transitions.
   - Clean barge-in requires synchronizing cancellation across the telephony/transport layer, the LLM token stream, and the TTS synthesis stream simultaneously — not just stopping audio playback.
2. **Voice changes prompt quality, for better and worse**, from "Voice Can Make Coding Agents Better (In Some Cases)" (https://nima.sadri.ai/random/voice-input-agents.html via HN https://news.ycombinator.com/item?id=47239366, fetched 2026-10-29):
   - Spoken prompts to a coding agent were observed to be substantially richer/longer than typed ones for analytic/structured tasks (the example given: a verbal bug report naturally included full reasoning about token-refresh timing that a 5-word typed prompt would have omitted). Rationale cited: typing competes for working memory between motor control and planning; speech offloads the motor part.
   - Counter-finding: for problems needing an intuitive/insight breakthrough, forced verbalization *hurt* performance — typing was better there.
   - Word-level highlighting synchronized to TTS playback ("karaoke-style") was found to reduce zoning out versus plain audio output — a concrete UX pattern worth carrying into a voice-manager design for spoken status summaries.
   - Overall takeaway explicitly stated: interface/modality design affects agent output quality roughly as much as the underlying model does.
3. **Qwen Audio Agent's own architecture doc** (`docs/architecture/deep-dive.md` in the repo, fetched 2026-10-29) is itself a rich primary source on async delegation + spoken status design, directly answering the "learnings" ask even though it's framework documentation rather than a blog post:
   - Core interaction primitive is `spawn_thinking(objective)`: "`spawn_thinking` never waits for the requested work. The user can continue speaking while work runs." The realtime/voice layer never blocks on the backend agent.
   - Admission control: "one active slot globally and one per owner; later requests queue." This directly encodes a policy decision a voice-manager-agent builder will have to make: how many concurrent backend agent turns can be in flight before new voice requests queue.
   - Status checks are decoupled from execution: `get_agent_task_status` is "the single Realtime entry point for lifecycle, progress, and interim-result questions" and explicitly "does not create another Task, invoke the coordinator, or enter the asynchronous announcement queue" — i.e., asking "how's it going?" by voice is cheap and doesn't perturb the running work.
   - Results return to the live conversation only "after waiting for a safe duplex insertion window" — an explicit design rule for not barging in on the user with a spoken status update while they're mid-sentence.
   - Permission requests from the backend agent surface to the voice layer as a single `respond_permission` tool, with natural-language yes/no resolution (including non-English acknowledgements like "可以" / "不允许") rather than requiring exact keyword matching — a reusable pattern for voice-driven tool-permission approval.

---

## Synthesis: closest prior art and what's greenfield

**Closest existing prior art, ranked:**

1. **Qwen Audio Agent** (https://github.com/QwenAudio/qwen-audio-agent, ~3,070 stars, Apache-2.0, pushed 2026-10-29) is architecturally the nearest thing to a standalone "voice manager agent." It explicitly separates a lightweight realtime **Frontend Agent** (conversation, cheap tool calls) from an **Orchestration Runtime** (task admission, queueing, permission routing, result delivery) from a **Backend Agent** (the actual coding work, via native ACP for OpenCode/Qoder/Kimi Code/MiniMax/Hermes/DeepSeek Harness, or external ACP adapters for Codex and **Claude Code**). It supports multiple concurrent backend tasks, non-blocking delegation (`spawn_thinking`), persistent per-owner coordinator ACP sessions, voice-triggered permission approval, and asynchronous "it's ready" spoken callbacks. Its main gap versus a pure "voice manager of agent *sessions*" is that it still centers on one voice conversation driving one coordinator session per backend, rather than a dashboard-style N-sessions-at-once mental model — but the primitives (task admission queue, status polling tool, async announcement queue) are exactly the right shape to extend into that.
2. **Paseo** (https://github.com/getpaseo/paseo, ~22,403 stars, Apache-2.0) is the closest match on the "orchestrate many coding-agent sessions across Claude Code/Codex/OpenCode" half of the brief (true multi-session, multi-provider, worktree-based orchestration, desktop+mobile+CLI), and it does have a shipped, local-first Voice Mode — but that voice mode is documented as "a hidden agent session," i.e. one voice-accessible orchestrator, not a dedicated outer voice loop built to manage and narrate across many independent sessions the way a phone-call-style manager would. It is the best reference implementation for "how do I wire local STT (Parakeet)/TTS (Kokoro)/cloud fallback (OpenAI) into an agent session that itself can launch other agent sessions."
3. **Happy Coder** (https://github.com/slopus/happy, ~24,397 stars, MIT) claims the ingredients (parallel Claude/Codex/Grok sessions + "built-in voice agent") but its voice mechanism is not documented in the sources checked here — worth a deeper code-level dive before relying on it as a reference implementation.
4. The small single-maintainer MCP voice servers (VoiceMode and its many cousins) are useful as **STT/TTS plumbing references** (what local Whisper.cpp/Kokoro/Parakeet/mlx-audio setups look like, how to expose `converse`/`listen`/`speak` as MCP tools) but are architecturally the *wrong* layer for a manager agent: they're tools the coding agent itself calls, not an outer process that drives/interrupts/narrates across multiple coding-agent sessions.

**What's missing / genuinely greenfield for a "voice manager agent" that orchestrates Claude Code / OpenCode / T3 Code threads:**

- **An outer voice loop that owns N agent sessions as peers**, not one hidden orchestrator session. Every project surveyed here either (a) is a 1:1 voice↔one-agent-session bridge (most MCP voice servers), or (b) centers voice around a single hidden coordinator session that then fans out to backend work (Qwen Audio Agent, Paseo). None treat "my Claude Code session on project A" and "my OpenCode session on project B" and "my T3 Code thread C" as a set of independently addressable, nameable, interruptible things the voice layer juggles directly, with the voice UI itself (not a backend LLM call) deciding which thread a given utterance targets.
- **Voice-native ACP client**: ACP is the right abstraction layer (one JSON-RPC surface for Claude Code, OpenCode, Codex CLI, Gemini CLI), and Qwen Audio Agent proves it's workable, but no narrowly-scoped, reusable "voice↔ACP" client library exists independent of Qwen Audio Agent's full product (Chumby's design is unimplemented; `kodizm/acp` and `vscode-acp` show multi-backend ACP clients exist but with zero voice involvement). Extracting "voice front-end + generic ACP client that can attach to *any* number of already-running ACP agent processes/sessions" as its own small library looks genuinely open.
- **Cross-session barge-in semantics**: the sub-500ms voice-agent HN post's lesson ("voice is a turn-taking problem") and Qwen Audio Agent's "safe duplex insertion window" rule both describe turn-taking *within one conversation*. Nobody surveyed here has published a design for turn-taking when there are multiple *backend* sessions that might all want to announce completion at once while the user is talking to a third one — i.e., a priority/scheduling policy for spoken interruptions sourced from concurrent async agent work. This is squarely unsolved in public prior art and is exactly the hard part of a "phone call with your fleet of coding agents" product.
- **Spoken session management UX** (naming threads, switching between them by voice, "pause B, what's A up to," forking/resuming by spoken reference rather than typed session IDs) has no public reference implementation; the underlying SDK primitives for it (Claude Agent SDK's `listSessions`/`resume`/`fork`, OpenCode's `/session` hierarchy + `/session/:id/abort`) are ready and waiting.
- T3 Code specifically: no evidence found (expected, since it is not a widely public product at the time of this research) of any third-party voice integration; a voice manager targeting T3 Code threads would be new ground almost by definition, and would need to be built against T3's own thread/session control surface rather than an existing OSS adapter.

**Bottom line for someone building this**: don't build STT/TTS or ACP plumbing from scratch — Pipecat/LiveKit Agents (realtime voice pipeline), the ACP ecosystem (`claude-code-acp`, OpenCode's native `opencode acp`, `agentclientprotocol/codex-acp`), and the Claude Agent SDK / OpenCode server's streaming+interrupt+session APIs are all solid, documented, and actively maintained. The genuinely new work is the orchestration/UX layer on top: a scheduler that treats multiple live agent sessions as independent, interruptible, voice-addressable "callers on hold," decides when it's safe to interject a status update, and maps ambiguous spoken references ("tell the OpenCode one to stop," "how's the Claude thread on the auth bug") onto the right session's ACP/SDK handle. Qwen Audio Agent is the single best existing reference architecture to study and extend for that layer.
