# Voice calls in the app: results

Date 2026-10-29. The voice worker (`services/voice`, Pipecat 1.15) managed by the app, calls
through the real app (signalling via `/api/voice`, the bridge into `ChatService.prompt`), driven by
`e2e/voice-call.spec.ts`: headless Chromium on dev with a fake microphone playing
`tests/scenario.py` (5 utterances, a silent tool call, a barge-in, one proactive event). GPU
speech = `services/speech-gpu` on the GPU host's RTX 3070 (Parakeet STT, Kokoro TTS with the new
server-side silence trim) through the SSH tunnels; CPU = faster-whisper base.en + kokoro-onnx on
dev. Every run below PASSes. One call per configuration (5 user turns): indicative, not
statistics. Raw reports in [results/](results/).

## User stops speaking → first agent audio (median, p90 in brackets)

| | agent | server: first agent audio out | browser: mouth → agent heard | agent TTFT |
|---|---|---|---|---|
| **app, GPU speech** | Claude Code, Haiku | **2129 ms** (3624) | **2361 ms** (3869) | 1065 ms |
| app, CPU speech | Claude Code, Haiku | 3270 ms (3623) | 3519 ms (3856) | 1248 ms |
| app, GPU speech | fake agent (instant) | 488 ms (810) | 694 ms¹ | 4 ms |
| app, CPU speech | fake agent (instant) | 1335 ms (1461) | 1560 ms¹ | 3 ms |
| prototype, GPU speech | Claude Code, Haiku | 2291 ms (2962) | 2587 ms (3254) | 1628 ms |
| prototype, GPU, best run | Claude Code, Haiku | 2163 ms | 2515 ms | |
| prototype, CPU speech | Claude Code, Haiku | 2643 ms (3855) | 2894 ms (4111) | 1191 ms |

¹ median; those reports predate the analyzer fix that skips turns whose reply follows a filler
without a gap (their p90 is meaningless, see the raw files).

- **On GPU the app matches the prototype** (2.13 s vs 2.29 s out, 2.36 s vs 2.59 s heard), with
  the agent going through the app's ACP runtime, the bridge, the DM persistence and the
  voice-mode note. The fake-agent rows show what the pipeline itself costs: ~0.5 s on GPU (VAD
  200 ms, Smart Turn ~55 ms, Parakeet 75 ms, Kokoro first byte ~105 ms, frame out ~40 ms), ~1.3 s
  on CPU. The bridge and `chat.prompt` add a few ms (prompt → first update 2–4 ms with the fake).
- **The ack is gone**, so nothing is heard until the reply: the prototype's ~0.5 s "mm-hmm" no
  longer masks the wait. Fillers still play on silent tool calls (318 ms GPU / 804 ms CPU after
  the user stopped, fake agent).
- **TTS silence trim at the source** works: `smoke.py` measures 30 ms before the first sound and
  120 ms after the last (was ~350 / ~500 ms); Kokoro first byte ~105 ms from dev.
- **Warm-up**: starting a call spawns the agent's harness and opens its session (`chat.warm`), so
  the first turn's agent TTFT on GPU was 1.56 s instead of the 2.81 s a cold spawn cost in an
  earlier run. (The prototype also spent a warm-up *prompt* on the cache-cold first turn; the app
  doesn't, to not cost a request per call.)
- **CPU with Claude is slower than the prototype's CPU** (3.27 s vs 2.64 s): kokoro-onnx's first
  byte was 516 ms vs 309 ms, with the app, Claude Code, the worker and Chromium sharing dev's six
  cores. The CPU path is a fallback; GPU is the default.
- Barge-in: cancel goes out 0 ms after the user starts talking over a running turn and the turn
  resolves `cancelled` ~8 ms later (fake agent). With Haiku the reply is usually fully written
  before the barge-in, so only the audio stops (and the next prompt says it was cut off).

## Where the time goes (Claude Haiku, GPU; ms after the user stopped)

```
VAD stop                 200
end-of-turn decision     267
STT result / prompt      284   (Parakeet 80 ms incl. tunnel)
first ACP update        1368   (prompt +1065)
first ACP text chunk    1638
first sentence to TTS   1987
first TTS audio byte    2090   (Kokoro 105 ms)
agent audio out         2129
agent audio heard       2361
```

The agent is still the floor: prompt → first text ~1.1–1.6 s. Next levers are the ones the
prototype listed (talker/reasoner split, speculative prompting at the Smart Turn decision,
first-clause TTS).

## 2026-10-30: whole-turn speech recognition

The STT now hears each user turn whole (`voice_worker/turns.py`) and the STT server passes
Parakeet the real audio length: 10.3 → 3.0 % WER on the new evaluation set
(`services/speech-gpu/BENCHMARKS.md`). The e2e call (fake agent, GPU speech) transcribed all five
utterances exactly with STT 46 ms (request → text) and the same turn latency as before (first
agent audio out: median 512 ms after the user stopped).

## Known issues seen in these runs

- Smart Turn called "Sorry, stop. Just say goodbye." incomplete in some runs (twice today); the turn then
  ended on Pipecat's ~3 s silence fallback (prompt at 3.2 s).
- The analyzer's "heard" join needs an audio onset; a reply that follows a filler or another
  reply without a gap has none and is skipped (fixed in `analyze.py`).
- Not yet tried from km-mbp with a headset (media on dev only, host candidates).
