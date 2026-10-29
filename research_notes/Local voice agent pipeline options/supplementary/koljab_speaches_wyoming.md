## Research Report: Local-First Open-Source Voice Agent Projects (as of Oct 29, 2026)

### 1. KoljaB/RealtimeSTT
- **Repo**: [github.com/KoljaB/RealtimeSTT](https://github.com/KoljaB/RealtimeSTT) — 10,212 stars, 863 forks, MIT license, Python. [Source](https://github.com/KoljaB/RealtimeSTT)
- **Activity**: last push 2026-10-28 (yesterday relative to research date); latest release `v1.1.2` published 2026-08-30; 148 open issues; 408 commits total. Actively maintained. [Source](https://github.com/KoljaB/RealtimeSTT)
- **~28 contributors** (derived from GitHub contributors pagination, `per_page=1` → last page 28). [Source](https://api.github.com/repos/KoljaB/RealtimeSTT/contributors)
- **What it is**: a component — a low-latency STT *library*, not a full orchestrator. Ships an optional FastAPI client/server mode (WebSocket) for remote deployment. [Source](https://github.com/KoljaB/RealtimeSTT/blob/master/RealtimeSTT_server/README.md)
- **VAD**: dual approach — WebRTC VAD and Silero VAD, selectable. [Source](https://github.com/KoljaB/RealtimeSTT)
- **STT engines**: faster-whisper (default), whisper.cpp, OpenAI Whisper, Moonshine, sherpa-onnx, Kroko-ONNX, and others. [Source](https://github.com/KoljaB/RealtimeSTT)
- **Pluggability**: event-callback model (on_recording_start, on_vad_detect, on_realtime_transcription_update, on_wakeword_detected, etc.) — consumer code owns what happens next, so it's easy to wire into an arbitrary agent loop. [Source](https://github.com/KoljaB/RealtimeSTT)
- **macOS**: supported; requires `brew install portaudio`. [Source](https://github.com/KoljaB/RealtimeSTT)
- **Maintainer**: solo dev (Kolja Beigel), community PRs accepted.

### 2. KoljaB/RealtimeTTS
- **Repo**: [github.com/KoljaB/RealtimeTTS](https://github.com/KoljaB/RealtimeTTS) — 4,047 stars, 414 forks, MIT (+ addendum for third-party engines), Python. [Source](https://github.com/KoljaB/RealtimeTTS)
- **Activity**: last push 2026-10-28; latest release `v0.8.10` published 2026-09-27; 126 open issues; 642 commits. Actively maintained. [Source](https://github.com/KoljaB/RealtimeTTS)
- **~52 contributors** (pagination-derived). [Source](https://api.github.com/repos/KoljaB/RealtimeTTS/contributors)
- **What it is**: a component — streams text/token-generator input to speech with low latency; handles engine fallback chains.
- **Local TTS engines**: Coqui XTTS, Piper, Kokoro, StyleTTS2, Parler, OmniVoice, PocketTTS, NeuTTS, ZipVoice, LuxTTS, Chatterbox, Soprano/SoproTTS, MOSS-TTS, plus a "QwenEngine" and "InflectEngine," alongside cloud engines (OpenAI, Azure, ElevenLabs, Cartesia, etc.) and system/free engines (SystemEngine, gTTS, Edge). [Source](https://github.com/KoljaB/RealtimeTTS)
- **macOS**: explicit CPU-wheel support — Intel macOS 13+ and Apple Silicon macOS 11+; PortAudio via Homebrew needed for playback. [Source](https://github.com/KoljaB/RealtimeTTS)
- **Maintainer**: solo dev, same as RealtimeSTT.

### 3. KoljaB/RealtimeVoiceChat
- **Repo**: [github.com/KoljaB/RealtimeVoiceChat](https://github.com/KoljaB/RealtimeVoiceChat) — 3,868 stars, 459 forks, **no license file** (per GitHub API `license: null`, despite some third-party summaries calling it MIT — treat license as unconfirmed/unspecified), Python. [Source](https://github.com/KoljaB/RealtimeVoiceChat)
- **Activity**: last push **2025-07-11** — i.e., ~15.5 months stale as of Oct 2026; no formal GitHub release exists; 41 open issues. **Not actively maintained** — repo itself states the creator has stepped back from new features/support and it is now "community-driven" (PR-only maintenance). [Source](https://github.com/KoljaB/RealtimeVoiceChat)
- **Only ~2 contributors** by pagination. [Source](https://api.github.com/repos/KoljaB/RealtimeVoiceChat/contributors)
- **What it is**: the full pipeline orchestrator in this family — mic capture → WebSocket streaming → RealtimeSTT → LLM → RealtimeTTS → browser playback, achieving ~500ms round-trip latency. [Source](https://news.ycombinator.com/item?id=43899028)
- **VAD/turn detection**: layered on RealtimeSTT's VAD plus a dedicated `turndetect.py` module doing adaptive silence-duration-based turn-taking (not a learned turn-detection model). [Source](https://raw.githubusercontent.com/KoljaB/RealtimeVoiceChat/main/README.md)
- **LLM pluggability**: `llm_module.py` defines a single `LLM` class with `SUPPORTED_BACKENDS = ["ollama", "openai", "lmstudio"]`, selected via `LLM_START_PROVIDER`/`LLM_START_MODEL`. Backend dispatch is via hardcoded `if/elif` branches in `generate()`, each with its own client/connection/chunk-yield helpers — **there is no generic streaming-callback or plugin interface**; swapping in an arbitrary custom LLM/agent call (e.g., Claude Agent SDK) would require adding a new `elif` branch and implementing a token-generator wrapper (`Generator[str, None, None]`) around it. It is not simply "point it at any HTTP endpoint" the way an OpenAI-compatible-only design would be, but also not plugin-architected — moderate retrofit effort. [Source](https://raw.githubusercontent.com/KoljaB/RealtimeVoiceChat/main/code/llm_module.py)
- **Interruption/barge-in**: WebSocket-based; new user audio triggers cancellation of in-flight TTS/LLM generation ("Jump in anytime"). [Source](https://raw.githubusercontent.com/KoljaB/RealtimeVoiceChat/main/README.md)
- **Filler speech / proactive speech**: **not supported** — no documented mechanism for filler/status utterances during long LLM turns, and no agent-initiated/proactive speech feature. [Source](https://raw.githubusercontent.com/KoljaB/RealtimeVoiceChat/main/README.md)
- **macOS**: manual install possible but "may require more troubleshooting (especially for DeepSpeed)"; Docker/Linux+GPU is the recommended path. [Source](https://raw.githubusercontent.com/KoljaB/RealtimeVoiceChat/main/README.md)
- **Transport**: WebSocket only (browser client ↔ FastAPI backend); no native desktop/mic app, no WebRTC.

### 4. Speaches (speaches-ai/speaches, formerly faster-whisper-server)
- **Repo**: [github.com/speaches-ai/speaches](https://github.com/speaches-ai/speaches) — 3,742 stars, 465 forks, MIT, Python. Renamed from `fedirz/faster-whisper-server` once it expanded beyond ASR; this is the canonical current org/repo. [Source](https://github.com/speaches-ai/speaches)
- **Activity**: last push 2026-10-26; 740 commits; 151 open issues, 41 open PRs; latest tagged release `v0.9.0-rc.3` (2025-12-27 — still a release candidate, no stable tag since). Actively maintained (frequent commits) but stable releases have lagged. [Source](https://github.com/speaches-ai/speaches)
- **~34 contributors** (pagination-derived). [Source](https://api.github.com/repos/speaches-ai/speaches/contributors)
- **What it is**: a component — an OpenAI-API-compatible local STT/TTS *server* ("Ollama, but for STT/TTS models"), not an orchestrator with LLM/agent logic or barge-in handling itself.
- **STT engine**: faster-whisper. **TTS engines**: Piper and Kokoro. [Source](https://github.com/speaches-ai/speaches)
- **Transport**: HTTP (OpenAI-compatible REST), SSE for streaming transcription, and WebSocket for the Realtime-API-style live transcription. [Source](https://github.com/speaches-ai/speaches)
- **LLM/agent step**: N/A — it's a speech-I/O server; LLM orchestration is left entirely to the caller.
- **macOS**: not explicitly documented; Docker/GPU-CPU support is the primary deployment path, no stated Apple Silicon notes found.
- **Maintainer**: community org (`speaches-ai`), not a single named individual, not a company.

### 5. Wyoming Protocol (now OHF-Voice/wyoming, formerly rhasspy/wyoming) + Home Assistant voice pipeline
- **Repo moved**: the `rhasspy/wyoming` repo returns HTTP "Moved Permanently" → current canonical location is [github.com/OHF-Voice/wyoming](https://github.com/OHF-Voice/wyoming). [Source](https://api.github.com/repos/OHF-Voice/wyoming)
- **Stats**: 411 stars, 55 forks, MIT, Python. Last push 2026-09-29; latest release `v1.10.2` (2026-08-27); 23 open issues; 135 commits. Actively maintained. [Source](https://github.com/OHF-Voice/wyoming)
- **~9 contributors** (pagination-derived). [Source](https://api.github.com/repos/OHF-Voice/wyoming/contributors)
- **Maintainer**: Open Home Foundation (OHF-Voice org) — created by Michael Hansen (synesthesiam); this is a nonprofit-foundation-backed project (Home Assistant's parent foundation), not a solo dev or for-profit company. [Source](https://github.com/OHF-Voice/wyoming)
- **What it is**: purely a **protocol** (JSONL + PCM audio over TCP) for wiring together independent voice-processing microservices (wake-word, ASR, TTS, intent, VAD) — it is not itself an orchestrator, STT, or TTS engine.
- **Reference satellite implementation**: `rhasspy/wyoming-satellite` (1,239 stars, 184 forks, MIT, Python) — was **archived by its owner on 2026-01-27** and is read-only/unmaintained now; last release `v1.4.1` (2025-02-10). [Source](https://github.com/rhasspy/wyoming-satellite)
- **Local STT via Wyoming**: `wyoming-whisper-cpp` (whisper.cpp) and Rhasspy-speech servers. **Local TTS**: Piper (via `wyoming-piper`). **Wake word**: `wyoming-openwakeword` (openWakeWord) and microWakeWord. [Source](https://github.com/orgs/rhasspy/repositories)
- **Reference architecture (Home Assistant Assist pipeline)**: wake word → STT (Whisper) → intent/LLM (Assist intents or Ollama-served local LLM) → TTS (Piper) → playback, entirely over LAN via Wyoming; this is the architecture referenced by the user's framing (lightweight protocol gluing independently-swappable local components) rather than a single orchestrator codebase. [Source](https://botmonster.com/smart-home/home-assistant-voice-pipelines-local-wake-word-wyoming/)
- **LLM pluggability**: very high at the architecture level — any Wyoming-speaking or Home-Assistant-conversation-agent-compatible backend can be swapped in (including custom integrations), since Wyoming's design goal is component substitutability; but Wyoming itself carries no barge-in/turn-orchestration logic — that lives in Home Assistant core's pipeline runner, not in the open protocol repo.
- **Barge-in**: not inherent to the protocol; barge-in/turn-taking is implemented by Home Assistant's own pipeline runner and by satellite implementations (now archived), not something Wyoming itself defines.
- **macOS**: N/A (server/addon based, run via Home Assistant OS/Docker on Linux typically; no Apple Silicon-specific notes found).

### 6. Other notable 2025–2026 local voice-agent projects found
- **Lex-au/Vocalis** — [github.com/Lex-au/Vocalis](https://github.com/Lex-au/Vocalis). 315 stars, 51 forks, Apache-2.0, TypeScript/Python (React + FastAPI). **Last push 2025-04-14 — stale ~18 months, not actively maintained as of Oct 2026.** [Source](https://github.com/Lex-au/Vocalis)
  - Full pipeline: custom VAD-gated faster-whisper STT → OpenAI-compatible LLM endpoint (built for LM Studio, ships a purpose-tuned `Vocalis-Q4_K_M.gguf` model) → Orpheus-FASTAPI or Kokoro-FASTAPI TTS, over WebSocket.
  - Notable distinguishing feature directly relevant to the report's "proactive speech" question: it explicitly supports **AI-initiated greetings and "Intelligent Follow-Ups"** triggered after 3–5s of silence — i.e., agent-initiated speech output, which neither the KoljaB stack nor Speaches/Wyoming documents.
  - No filler-speech-during-long-turns feature documented.
  - macOS: explicitly supported with M1–M4 setup scripts. [Source](https://github.com/Lex-au/Vocalis)
  - Maintainer: solo dev (Lex-au), low current activity (5 open issues, minimal recent commits).
- **syllabix-ai/syllabix** — [github.com/syllabix-ai/syllabix](https://github.com/syllabix-ai/syllabix). Brand-new (created 2026-08-15), 2 stars, Apache-2.0, Rust. Pitched as a single native binary implementing Mic → VAD → STT → (agentic) LLM with sandboxed shell/tool access → TTS → speakers, with echo cancellation and barge-in, running fully offline after first model download, cross-platform (Linux/macOS/Windows), no Python dependency. Last push 2026-10-29 (today) — very active but essentially unproven/pre-adoption (2 stars). Worth flagging as an emerging "agentic-LLM-in-the-loop" design distinct from the OpenAI-compatible-API-only pattern, but too new/unverified for strong conclusions. [Source](https://github.com/syllabix-ai/syllabix)
- Also surfaced but not verified in depth: a Hugging Face/Cerebras "fully local" reference pipeline (Silero VAD v5 → Parakeet TDT → Gemma → Qwen3-TTS) published around 2026-07-01, exposed via an OpenAI-Realtime-compatible WebSocket API — mentioned only in secondary blog sources, no primary GitHub repo URL was confirmed in this research pass, so treat as unconfirmed lead rather than a sourced fact. [Source](https://www.assemblyai.com/blog/orchestration-tools-ai-voice-agents)

### Notes on gaps / unverified items
- Could not confirm a license for RealtimeVoiceChat beyond GitHub API reporting `null` — third-party blog posts claim MIT, but no LICENSE file was found/confirmed directly; flag as unresolved if precision matters.
- Exact contributor counts are derived from GitHub's `contributors` endpoint pagination (`per_page=1`, last-page number), which is an approximation (caps around 500 and can undercount squashed/co-authored commits) — treat as directional, not exact.
- No primary-source confirmation found for the Hugging Face/Cerebras pipeline's GitHub repo URL — needs a follow-up search if it's to be cited as a primary source.