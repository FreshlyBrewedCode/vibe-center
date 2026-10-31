# voice worker

The Pipecat call pipeline behind Vibe Center's voice calls: WebRTC transport, Silero VAD +
Smart Turn v3 turn-taking, STT/TTS (GPU servers or CPU fallbacks), fillers, barge-in and the
latency log. It owns **no agent**: its LLM step goes back into the app over a per-call
WebSocket, and the app prompts the agent's own ACP session (`ChatService.prompt`, source
`voice`). Grown out of an earlier prototype (its results: [RESULTS-prototype.md](RESULTS-prototype.md)).

```
browser ──WebRTC media (UDP, direct)──▶ worker (this dir, Python)        STT/TTS servers
   │                                      ├─ VAD + Smart Turn v3 (CPU)    (services/speech-gpu on a
   │ offer/ICE/hang-up (HTTPS, cookie)    ├─ STT → BridgeTalker → TTS ───▶ GPU host, or CPU here)
   ▼                                      │
vibe-center app ──POST /calls (Bearer)───▶│
   ▲  /voice/bridge (WS, per-call token)  │
   └──────────────────────────────────────┘ prompt / cancel / state / latency ⇄ text / tool / done / event
```

## Run

The app runs it (Settings → Voice → "managed"): `run.sh` on a free loopback port with a fresh
token, restarted when it crashes, logged to `~/.vibe-center/logs/voice-worker.log`. By hand, for
a **remote** worker on another machine (then set its URL and token in Settings → Voice):

```sh
(umask 077; openssl rand -hex 24 > ~/.vc-worker-token)   # once; paste it into Settings → Voice
VC_WORKER_TOKEN=$(cat ~/.vc-worker-token) VC_WORKER_HOST=0.0.0.0 VC_WORKER_PORT=7860 ./run.sh
./run.sh check                                   # ruff + pytest
./run.sh python -m voice_worker.analyze          # newest call log: per-stage median/p90 + per-turn table
./run.sh python -m voice_worker.analyze <log> --browser <browser.json> --md
```

`run.sh` takes uv from PATH or nix (linked as `.uv`) and syncs the venv first (Python 3.12,
Pipecat 1.15, pinned in `uv.lock`). A remote worker must reach the app's `/voice/bridge` (the
tailnet URL by default) and the browser must reach the worker's host over UDP.

| env | default | |
|---|---|---|
| `VC_WORKER_TOKEN` | (required) | Bearer token for every request from the app |
| `VC_WORKER_HOST`, `VC_WORKER_PORT` | `127.0.0.1`, `7860` | HTTP listen address |
| `VC_VOICE_DATA_DIR` | `~/.vibe-center/voice` | `calls/*.jsonl` latency logs, `cues/` filler cache, `recordings/` (debug) |
| `WHISPER_MODEL` | `base.en` | CPU fallback STT (faster-whisper int8) |
| `VAD_STOP_SECS` | `0.2` | Silero silence before Smart Turn decides |
| `VAD_MIN_VOLUME` | `0.6` | loudness Silero also needs (0–1 over -110..-10 LUFS; Pipecat's default) |
| `STT_PREROLL_S` | `1.0` | audio kept before the VAD's speech start, so the first word isn't clipped |
| `PROMPT_TIMEOUT_S` | `45` | a voice turn longer than this is cancelled with a spoken apology |
| `TTS_VOICE` | `af_heart` | voice when the agent has none |

Per call the app sends the agent's voice, the STT/TTS URLs, the filler switch, the STT language
and vocabulary, the debug-recording count and the bridge URL + credential (`POST /calls`), so
settings changes need no restart.

## API (app → worker, Bearer token)

| | |
|---|---|
| `GET /health` | `{status: ok\|loading\|error, version, call}`; `loading` while the CPU models load (~3 s) |
| `POST /calls` | `{call_id, bridge_url, bridge_token, agent_name, voice, stt_url, tts_url, filler, vocabulary, stt_language, record_turns, sdp, type}` → `{sdp, type, pc_id, speech}`. Dials the bridge before answering. One call at a time: a new one ends the old. `vocabulary` (settings + agent names) goes to the STT as the OpenAI `prompt` and to the CPU Whisper as hotwords; `stt_language` `""` lets the model detect it; `record_turns` > 0 keeps that many turn recordings |
| `PATCH /calls/{id}/ice` | `{pc_id, candidates: [{candidate, sdp_mid, sdp_mline_index}]}` |
| `DELETE /calls/{id}` | hang up |
| `GET /voices?tts_url=` | the TTS server's voice list, else the CPU Kokoro's English voices |
| `POST /tts` | `{text, voice, tts_url}` → WAV (the voice picker's preview) |
| `GET /recordings` | `{recordings: [{id, call_id, turn, text, stt, duration, at}]}`, newest first: the debug turn recordings |
| `GET /recordings/{id}.wav` | one of them: 16 kHz mono, what the STT got for the whole turn |
| `DELETE /recordings` | `{deleted}` |

## Bridge protocol (worker ⇄ app, JSON over one WebSocket per call)

`voice_worker/bridge.py` (worker) and `packages/server/src/voice/bridge.ts` (app).

| worker → app | |
|---|---|
| `{type: "prompt", id, text, kind: "user"\|"event", context?}` | a finished user turn (or a proactive event, when the line is quiet). `context` is hidden extra text for the agent (barge-in notes) |
| `{type: "cancel", id}` | barge-in: cancels that turn only (`ChatService.cancelTurn` → ACP `session/cancel`) |
| `{type: "state", state: "listening"\|"thinking"\|"speaking"}` | call bar and presence detail |
| `{type: "latency", turn, kind, ms: {...}, bargeIn, tools}` | per-turn summary (ms after the user stopped speaking) |

| app → worker | |
|---|---|
| `{type: "hello", callId, agentName}` | first frame; proves the credential |
| `{type: "started", id, turnId}` / `{type: "usage", id}` | the turn exists / first sign of life from the harness |
| `{type: "text", id, text}` | reply chunk |
| `{type: "tool", id, toolCallId, title, status: "start"\|"end"}` | a tool call: sentence break, filler trigger |
| `{type: "permission", id, title}` | the agent waits for approval in the app (the worker says so) |
| `{type: "waiting", id, reason: "permission"\|"busy", title}` | the prompt is queued behind another turn: one waiting for approval in the chat (sent at once), or just a busy agent (after 2.5 s). The worker says so once per reason, and a blocked prompt that times out says it's still waiting for the approval |
| `{type: "done", id, status: "complete"\|"cancelled"\|"error", error?}` | |
| `{type: "event", text}` | proactive event to speak (the app's `voice.speakEvent` hook) |
| `{type: "mute", muted}` | the user (un)muted the call from any tab or device: the mic is replaced by silence |
| `{type: "end", reason}` | hang up |

## How a turn goes

`voice_worker/call.py` builds one pipeline per call:

```
transport.input → STT → TurnUserAggregator(Silero VAD, Smart Turn v3) → BridgeTalker → TTS → transport.output → OutputTap
```

- **Speech to text** (`turns.py`): the STT hears the whole user turn, not VAD fragments. Its
  buffer opens at the turn's first VAD start (with 1 s of pre-roll) and keeps everything,
  pauses included, until the turn ends; at every VAD stop the whole turn so far is transcribed
  and replaces the previous transcript. Pipecat's own segmented STT transcribed each piece
  between pauses alone and dropped what the VAD missed between them: on the evaluation set that
  was 10–15 % WER against 3–7 % now (`services/speech-gpu/BENCHMARKS.md`). The HTTP STT gets
  the vocabulary as `prompt` and the language; the CPU fallback (faster-whisper base.en) the
  vocabulary as hotwords. With `record_turns` the turn's audio and final transcript are kept in
  `<data>/recordings/` (the newest N).

- **Turn-taking**: Pipecat's default Silero VAD (stop 0.2 s) + `LocalSmartTurnAnalyzerV3`.
  `EndOfTurnStop` logs the decision. The end of the user's turn is **silent** (the prototype's
  "mm-hmm" ack is gone).
- **The LLM step** (`talker.py`, `BridgeTalker`): the user's text goes out as a `prompt`; text
  chunks come back as `LLMTextFrame`s and the TTS's sentence aggregator speaks them sentence by
  sentence. Code fences and backticks are dropped, markdown stripped. The app adds the
  voice-mode note (short spoken replies, no markdown) and records both sides as
  `voice_transcript` messages in the DM.
- **Tool calls** close the LLM response (`LLMFullResponseEndFrame`): a hard sentence break, and
  the pre-tool sentence is spoken now. A tool call before anything was said plays a cached
  **filler** ("One sec.", "Let me check.", …; synthesized once per voice with the CPU Kokoro).
- **Barge-in**: Pipecat's interruption stops the audio at once; a running prompt gets `cancel`.
  A prompt cancelled before the agent said anything (a mid-sentence pause ended the turn early)
  is named in the next prompt's `context`, so the agent reads the two halves as one turn. A
  reply that was cut off while being spoken adds "(I interrupted your previous reply…)".
- **Proactive events** wait until nobody speaks and the agent is idle for 600 ms, then go out as
  `kind: "event"` prompts and are spoken.
- **Robustness**: per-turn timeout (cancel + "Sorry, that's taking too long…"), agent errors are
  spoken as an apology, a permission request is announced, HTTP STT/TTS fall back to the CPU per
  request, and per call the GPU servers are used only if their `/health` answers.
- **Latency log**: `<data>/calls/call-<ts>-<id>.jsonl`, one record per turn (epoch ms):
  `speech_end`, `vad_stop`, `eot_decision`, `stt_request/response/result`, `turn_released`,
  `prompt_sent`, `first_update`, `first_chunk`, `filler_out`, `tts_request`, `tts_first_audio`,
  `first_audio_out`, tool calls, `barge_in`/`cancel_sent`, `prompt_done`, transcripts and reply.

## Evaluating speech recognition

`eval/` is a small evaluation set of things people say to a coding agent (36 utterances, 10
voices, pauses mid-sentence, clean / noisy / phone conditions) and a runner that pushes each clip
through Pipecat's VAD as a call would, then transcribes it the old way (VAD segments) and the new
way (whole turn):

```sh
./run.sh python -m eval.build                                   # synthesize the set (CPU Kokoro; cached)
./run.sh python -m eval.run --stt http://127.0.0.1:8401 [--vocab] # the STT server's active model
./run.sh python -m eval.run --stt cpu                           # the CPU fallback
./run.sh python -m eval.export                                  # the set as sent to the STT, for GPU benchmarks
```

Results (every hypothesis) land in `eval/out/results/<label>.json`; the numbers are in
`services/speech-gpu/BENCHMARKS.md`.

## Tests

- `./run.sh check`: ruff, and pytest for the bridge client (against an in-process fake app),
  the code-fence filter, the latency log, the cues, whole-turn transcription and the recordings
  (`test_turns.py`), the call's STT settings (`test_stt.py`); then the GPU speech server's model
  catalog API against fake models (`../speech-gpu/tests`)
- `packages/server/test/voice.test.ts`: the app side against `fake-voice-worker.ts`
- `e2e/voice-call.spec.ts`: a whole call through the real app and this worker, headless
  Chromium with a fake mic playing `tests/scenario.py` (synthesized by `tests/make_audio.py`),
  with turn recordings on (kept in `test-results/voice/recordings/`).
  Results and latencies: [RESULTS.md](RESULTS.md)
