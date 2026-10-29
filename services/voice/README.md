# voice-loop: phone-call voice loop over ACP

First prototype of the voice "manager agent". You talk to it from a browser like a phone call.
Speech in and out is local; the conversational brain is Claude Code (Haiku) driven over ACP
through `claude-agent-acp`, with the mock manager MCP tools (`list_sessions`, `dispatch_task`)
from `spikes/acp-latency`. English only. Results and measured latencies: [RESULTS.md](RESULTS.md).

```
browser (km-mbp) ──WebRTC (UDP, tailnet)──▶ dev: Pipecat 1.15 app (this dir)
   https://dev.taild544b4.ts.net:7443        ├─ Silero VAD + Smart Turn v3 (CPU)
   (tailscale serve → 127.0.0.1:7860)        ├─ ACP talker → claude-agent-acp → Claude Code (Haiku) + voice MCP tools
                                             └─ STT/TTS: GPU servers on km-pc via SSH tunnels (8401/8402)
                                                         or CPU fallback on dev (faster-whisper base.en, kokoro-onnx)
```

## Run it

```sh
cd prototype/voice-loop
../gpu-speech/speech.sh up      # optional: GPU STT/TTS on km-pc (see ../gpu-speech/README.md)
./run.sh                        # auto backend: GPU if both /health are OK, else CPU on dev
./run.sh local                  # force the CPU fallbacks
```

`run.sh` installs what's missing (`uv sync`, `bun install` in `agent/`; uv comes from nix if it
isn't on PATH), starts the server and a foreground `tailscale serve --https=7443`, waits until a
warmed-up ACP session is ready, and prints the URL. Ctrl+C stops the app and removes the
`:7443` serve entry. (Ports 443 and 8443 on dev are already served by other apps, hence 7443.)

**On km-pc's GPU servers:** when you are done, `../gpu-speech/speech.sh down` and `gpu sleep`.

### What to open on km-mbp

**https://dev.taild544b4.ts.net:7443/** in Chrome. Click **Call**, allow the microphone, talk.
**Use a headset.** Echo cancellation in the browser is on, but with laptop speakers the bot's
own voice can trigger barge-in and false turns, and real barge-in suffers. Click **Hang up**
to end the call.

The page shows the conversation (transcripts, replies, tool calls, barge-ins), the selected
ICE candidate pair, and a per-turn latency table (ms after you stopped speaking). The bold
column is the key number: first real (non-ack) agent audio leaving the server.

Things to try: "What are my agents doing?" (tool call), "Tell the backend agent to add an
index" (dispatch), interrupt a long answer ("Explain in detail how you'd coordinate five agents
on a refactor", then talk over it), and a proactive event from another terminal:

```sh
curl -X POST localhost:7860/event -H 'content-type: application/json' \
     -d '{"text": "frontend agent finished: the login bug is fixed and tests pass"}'
```

The event is held until you are not speaking, the bot is silent and the agent is idle (600 ms
of quiet), then sent as `[event] ...` and spoken.

### Why https, and how the media flows

`getUserMedia` needs a secure context, so the page and signalling (`POST /api/offer`) go through
`tailscale serve` (Tailscale's own cert for `dev.taild544b4.ts.net`). Only HTTP goes through
serve. The audio is WebRTC/UDP straight between the browser and the Python app (aiortc): the
client uses no STUN/TURN servers, both sides offer host candidates, and on the tailnet the
tailscale addresses (`100.x` / `fd7a:115c:a1e0::/48`) are directly reachable. The e2e test
verified media over dev's tailscale interface addresses (`--tailnet-only`). km-mbp ⇄ dev is a
direct Tailscale connection and both are also on the same LAN, so either path works.
Fallback if WebRTC ever fails: Pipecat's WebSocket transport (not needed so far).

## Configuration (env vars)

| var | default | |
|---|---|---|
| `SPEECH_BACKEND` | `auto` | `auto` / `http` (GPU servers) / `local` (CPU on dev). With `http`, a request that can't connect falls back to the CPU model, so a sleeping km-pc doesn't lose a turn |
| `STT_URL`, `TTS_URL` | `http://127.0.0.1:8401`, `:8402` | OpenAI-compatible endpoints (tunnels from `speech.sh up`) |
| `TTS_VOICE` | `af_heart` | Kokoro voice for replies and cached cues |
| `WHISPER_MODEL` | `base.en` | CPU fallback STT (faster-whisper, int8). `tiny.en` is ~2x faster, less accurate |
| `ACK` | `mhm` | end-of-turn acknowledgement: `mhm` ("Mm-hmm."), `okay`, `earcon` (soft two-note blip), `off` |
| `FILLER` | `on` | cached filler ("One sec.", "Let me check.", ...) when a tool call starts before anything was said |
| `VAD_STOP_SECS` | `0.2` | Silero silence before Smart Turn v3 decides (Pipecat's recommended value) |
| `TALKER_MODEL` | `haiku` | Claude model for the talker |
| `PROMPT_TIMEOUT_S` | `25` | per-prompt timeout → `session/cancel` + spoken apology |
| `WARMUP` | `1` | warm-up prompt on each new ACP session (not spoken) |
| `PORT`, `HTTPS_PORT` | `7860`, `7443` | app port, tailscale serve port |

Cues are synthesized once with the local kokoro-onnx (same voice) and cached in `assets/cues/`.

## How it works

`voice_loop/call.py` builds one Pipecat pipeline per call:

```
transport.input → STT → LLMUserAggregator(Silero VAD, Smart Turn v3) → AcpTalkerProcessor → TTS → transport.output → OutputTap
```

- **Turn-taking** is Pipecat's default: Silero VAD (`stop_secs` 0.2) + `LocalSmartTurnAnalyzerV3`
  via `TurnAnalyzerUserTurnStopStrategy`. Our subclass `EndOfTurnStop` additionally reports the
  moment Smart Turn decides the user is done. Pipecat itself waits for the transcript first.
- **Instant ack:** on that decision the talker pushes the cached ack audio straight to the output,
  before STT has finished. One ack per turn.
- **ACP talker** (`voice_loop/acp_talker.py`, Python `agent-client-protocol` 0.12): one long-lived
  `claude-agent-acp` session per call, Haiku, persona appended to the Claude Code preset,
  `ENABLE_TOOL_SEARCH=false`, voice MCP tools pre-allowed. The server keeps one session spawned
  and warmed up ahead of time (`TalkerPool`), so a call starts without the ~0.8 s spawn and the
  cache-cold first turn. Conversation history lives in the ACP session; the Pipecat context is
  cleared after each turn.
- **Streaming speech:** `agent_message_chunk` text goes out as `LLMTextFrame`s; the TTS service's
  sentence aggregator splits sentences. A **tool call closes the LLM response**
  (`LLMFullResponseEndFrame`), which flushes the aggregator: a hard sentence break (no "On
  it.Done"), and the pre-tool sentence is spoken now rather than waiting for look-ahead text.
  Fenced code blocks and backticks are dropped in the talker; Pipecat's `strip_markdown`
  transform runs on every sentence before TTS.
- **Filler:** a tool call before any spoken text plays a cached filler (rotating).
- **Barge-in:** Pipecat's interruption (user starts speaking) stops the audio at once. If the
  prompt is still running, the talker sends `session/cancel`. Events of the cancelled prompt
  are dropped, and the session keeps its context. If the reply was already fully generated but
  only partly heard, the next prompt is prefixed with "(I interrupted your previous reply.)".
  If a prompt is cancelled before the agent said anything (a mid-sentence pause ended the turn
  early), its text is prepended to the next prompt so the two halves read as one turn.
- **GPU TTS silence trim:** the km-pc Kokoro server pads each sentence with ~350 ms of leading
  and ~500 ms of trailing silence; `HttpTTSService` trims it to 30 / 120 ms while streaming.
- **Robustness:** per-prompt timeout (cancel + "Sorry, that's taking too long..."), ACP errors
  are spoken as an apology, and HTTP STT/TTS fall back to CPU per request.
- **Latency log:** `logs/call-<ts>.jsonl`, one record per turn (epoch ms): `speech_end`
  (VAD stop - stop_secs), `vad_stop`, `eot_decision`, `ack_pushed`/`ack_out`, `stt_request`/
  `stt_response`/`stt_result`, `turn_released`, `prompt_sent`, `first_update` (ACP
  `usage_update`), `first_chunk`, `filler_out`, `tts_request` (first sentence to TTS),
  `tts_first_audio`, `first_audio_out` (first TTS frame after the output transport), tool calls
  (start/end), `barge_in`/`cancel_sent`, `prompt_done`, plus transcripts and the reply text.

```sh
uv run python -m voice_loop.analyze                    # newest call log: per-stage median/p90 + per-turn table
uv run python -m voice_loop.analyze logs/call-*.jsonl  # several calls pooled
uv run python -m voice_loop.analyze <log> --md         # markdown tables
```

## Tests

```sh
uv run python -m voice_loop.acp_talker        # ACP smoke test: two turns, printed timings
uv run python -m tests.e2e --backend local    # full e2e over WebRTC with the CPU speech stack
uv run python -m tests.e2e --backend http     # same against the GPU servers (speech.sh up first)
uv run python -m tests.e2e --no-server --port 7860 --url https://dev.taild544b4.ts.net:7443/ --tailnet-only
                                              # through tailscale serve, ICE limited to tailscale addresses
```

The e2e test starts the server on port 7861, launches headless Chromium (nixpkgs build in
`.chromium`, via Playwright) with a fake microphone playing `tests/out/scenario-local.wav`:
utterances synthesized from `tests/scenario.py` with a male Kokoro voice, separated by silence.
It includes a barge-in during agent thinking and one while the bot speaks, plus an injected
proactive event. It then checks the call log (transcripts, replies, a tool call, barge-in,
`session/cancel`, the event turn) and prints the analysis. Its output goes to
`tests/out/e2e-<backend>-<ts>/`: `server.log`, `call-*.jsonl`, and `browser.json` with the
page's own mic/speaker onsets (same clock as the server), which give mouth-to-ear numbers.

## Layout

```
voice_loop/   server.py (FastAPI: page, /api/offer, /event, /events SSE, /status), call.py (pipeline),
              talker.py (ACP talker processor, EndOfTurnStop, OutputTap), acp_talker.py (ACP client),
              speech.py (HTTP + CPU STT/TTS), cues.py (ack/filler cache), latency.py, analyze.py, config.py
client/       index.html: minimal WebRTC client (no SDK), latency table
agent/        claude-agent-acp 0.99.0 + mock MCP server (mcp-server.ts, from spikes/acp-latency)
tests/        scenario.py, make_audio.py, e2e.py
```
