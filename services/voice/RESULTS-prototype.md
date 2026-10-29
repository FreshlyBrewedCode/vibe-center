# voice-loop prototype: results

Date 2026-10-29. Pipecat 1.15.0, `agent-client-protocol` 0.12.1 (Python), claude-agent-acp
0.99.0 → Claude Code, Haiku (`haiku` alias), one long-lived ACP session per call. dev: 6 CPU
cores, no GPU. GPU speech: `prototype/gpu-speech` on km-pc's RTX 3070 (Parakeet-TDT 0.6B v2
STT, Kokoro-82M TTS) through SSH tunnels. All numbers come from the automated e2e test
(`tests/e2e.py`). It drives the real WebRTC path in headless Chromium on dev, with a fake mic
playing a scripted call (`tests/scenario.py`: 8 utterances, two barge-ins, one proactive event).
These are small samples (2–3 runs, ~20 turns per backend), so treat them as indicative.

## What works

All of it, end to end over WebRTC. Every e2e run below PASSes.

| behaviour | status |
|---|---|
| WebRTC (SmallWebRTC/aiortc) from a browser, https via `tailscale serve` on `:7443` | ✅ media verified on dev's tailscale interface addresses (`--tailnet-only` run through `https://dev.taild544b4.ts.net:7443`). Not tried from km-mbp itself |
| Turn-taking: Silero VAD (stop 0.2 s) + Smart Turn v3 (Pipecat default stop strategy) | ✅ end-of-turn decision 250–310 ms after the user stops |
| Instant ack (cached "Mm-hmm."), before STT | ✅ leaves the server ~295 ms, heard in the browser ~510–540 ms after the user stopped |
| Streaming text → TTS sentence by sentence, hard break at tool calls, markdown/code stripped | ✅ ("On it." is spoken before the tool runs; no glued "it.Done") |
| Filler on a tool call before any speech | ✅ Haiku skipped the pre-tool sentence in 4 of 24 tool calls; the filler covered each |
| Barge-in: audio stops at once; `session/cancel` when the prompt is still running | ✅ 18 barge-ins while speaking, 15 while the agent was thinking (cancel sent within 0 ms of speech start, prompt resolves `cancelled`, the next turn has the context) |
| Prompt timeout → cancel + spoken apology, session recovers | ✅ tested with `PROMPT_TIMEOUT_S=1.3`: 4 timeouts, apology spoken, later turns normal |
| Warm-up turn, pre-spawned warmed session (call starts with no ACP cold start) | ✅ spawn ~0.8 s + warm-up ~1.5 s happen before the call |
| Latency log (JSONL per turn) + `analyze` (median/p90 + per-turn table) | ✅ |
| Proactive event `POST /event` → spoken only when user and bot are idle | ✅ e.g. "The frontend agent says the login bug is fixed and all tests pass." |
| HTTP STT/TTS → CPU fallback per request if km-pc is unreachable | ✅ full e2e PASS with km-pc asleep |

## The key number: user stops speaking → first real agent audio

| | CPU fallback on dev | GPU on km-pc |
|---|---|---|
| server: first agent audio frame out, median (p90) | **2643 ms (3855)** n=20 | **2219 ms (3134)** n=21 |
| browser: mouth → agent audio heard, median (p90) | **2894 ms (4111)** n=20 | **2587 ms (3254)** n=14 |
| browser: mouth → ack heard, median (p90) | 504 ms (587) | 537 ms (602) |

The "browser" rows come from the page's own level detectors: when its mic signal went silent,
and when the bot's audio became audible. The page runs on the same clock as the server, so
these are true mouth-to-ear numbers, including WebRTC send/receive and the jitter buffer
(server frame out → heard ≈ 100–120 ms). The GPU browser row uses only the 2 runs after the TTS
silence fix (see known issues); the server row pools all 3 GPU runs.

**Where the time goes** (medians, ms after the user stopped speaking):

```
                         CPU                        GPU
VAD stop                 200                        200
end-of-turn decision     267                        254
ack out                  295  (heard ~505)          294  (heard ~537)
STT result / prompt      770  (whisper 570 ms)      264  (parakeet 59 ms incl. tunnel)
first ACP update        1760  (prompt +1026)       1573  (prompt +1294)
first ACP text chunk    1965  (prompt +1191)       1931  (prompt +1628)
first sentence to TTS   2110                       2102
first TTS audio byte    2607  (kokoro-onnx 309)    2255  (GPU kokoro 85 incl. tunnel)
agent audio out         2643                       2291
agent audio heard       2894                       2587
```

The agent dominates. The ACP prompt → first text chunk takes 1.2–1.6 s median (p90 2.4–2.9 s),
the same floor the ACP spike measured, and tool turns add another model call (~1.3 s), which
the "Let me check." / filler covers. On GPU, STT and TTS together are ~150 ms; on CPU ~0.9 s.
The two GPU runs here had a slower Haiku than the CPU runs (1.6 s vs 1.2 s median TTFT),
which hides part of the GPU gain. A like-for-like estimate is CPU minus ~0.75 s, i.e. ~1.9 s
server-side and ~2.2 s heard. The best GPU run (`e2e-http-20261029-201020`) had agent audio out
at median 2163 ms, heard at 2515 ms.

### Pooled tables

CPU fallback (faster-whisper base.en int8 + kokoro-onnx on dev; 3 runs: `e2e-local-20261029-194135`,
`e2e-local-20261029-201242`, `e2e-local-tailnet-20261029-194524`):

| stage (ms after user stopped speaking) | n | median | p90 | min | max |
|---|---|---|---|---|---|
| VAD stop fired | 24 | 200 | 200 | 200 | 200 |
| end-of-turn decision | 24 | 267 | 309 | 253 | 316 |
| ack audio out | 24 | 295 | 327 | -4059¹ | 350 |
| STT result | 24 | 770 | 799 | 733 | 831 |
| prompt sent | 24 | 771 | 799 | 734 | 832 |
| first ACP update | 23 | 1760 | 2123 | 1360 | 3543 |
| first ACP text chunk | 22 | 1965 | 3436 | 1360 | 3999 |
| first sentence to TTS | 22 | 2110 | 3639 | 1557 | 4064 |
| first TTS audio byte | 20 | 2607 | 3808 | 1866 | 4345 |
| **FIRST AGENT AUDIO OUT** | 20 | **2643** | **3855** | 1900 | 4380 |
| STT (request→text) | 24 | 570 | 598 | 533 | 631 |
| agent TTFT (prompt→1st chunk) | 25 | 1191 | 2355 | 603 | 3229 |
| agent 1st update (prompt→usage) | 26 | 1026 | 1329 | 603 | 2773 |
| TTS TTFB (sentence→1st byte) | 23 | 309 | 819 | 254 | 1599 |
| TTS→wire (1st byte→frame out) | 23 | 38 | 42 | 33 | 48 |
| tool call (start→end, ACP) | 12 | 37 | 60 | 8 | 71 |
| browser: mouth→ack heard | 24 | 504 | 587 | | 638 |
| **browser: MOUTH→AGENT HEARD** | 20 | **2894** | **4111** | 2164 | 4708 |
| browser: frame out→heard | 20 | 101 | 135 | 64 | 152 |

GPU (Parakeet + Kokoro-82M on km-pc via tunnels; 2 runs after the TTS trim fix:
`e2e-http-20261029-200759`, `e2e-http-20261029-201020`):

| stage (ms after user stopped speaking) | n | median | p90 | min | max |
|---|---|---|---|---|---|
| VAD stop fired | 22 | 200 | 200 | 200 | 200 |
| end-of-turn decision | 22 | 254 | 264 | 251 | 281 |
| ack audio out | 22 | 294 | 311 | 284 | 326 |
| STT result | 22 | 264 | 298 | 256 | 320 |
| prompt sent | 22 | 265 | 299 | 257 | 321 |
| first ACP update | 15 | 1573 | 2141 | 1343 | 2510 |
| first ACP text chunk | 15 | 1931 | 2551 | 1343 | 3512 |
| first sentence to TTS | 15 | 2102 | 2742 | 1417 | 3752 |
| first TTS audio byte | 14 | 2255 | 2921 | 1497 | 3859 |
| **FIRST AGENT AUDIO OUT** | 14 | **2291** | **2962** | 1534 | 3899 |
| STT (request→text) | 22 | 59 | 65 | 52 | 82 |
| agent TTFT (prompt→1st chunk) | 17 | 1628 | 2252 | 1085 | 3243 |
| agent 1st update (prompt→usage) | 17 | 1294 | 1808 | 1085 | 2249 |
| TTS TTFB (sentence→1st byte) | 16 | 85 | 108 | 65 | 167 |
| TTS→wire (1st byte→frame out) | 16 | 38 | 40 | 32 | 42 |
| tool call (start→end, ACP) | 8 | 23 | 204 | 8 | 238 |
| browser: mouth→ack heard | 22 | 537 | 602 | 458 | 615 |
| **browser: MOUTH→AGENT HEARD** | 14 | **2587** | **3254** | 1785 | 4218 |
| browser: frame out→heard | 14 | 121 | 137 | 106 | 142 |

¹ Negative ack values: the ack played at a mid-utterance pause that Smart Turn judged complete
("Explain in detail." … "how you would…"). The user went on, so `speech_end` moved later.

Per-turn, best GPU run (`e2e-http-20261029-201020`; ms after the user stopped; "heard" = browser):

| # | eot | ack | stt | prompt | 1st chunk | 1st tts | AGENT OUT | heard | tools | barge-in | user said | reply |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 263 | 294 | 269 | 269 | 2001 | 2221 | 2363 | 2645 |  |  | Hey, can you hear me okay? | Yes, I can hear you clearly. What would you like me to check… |
| 2 | 264 | 304 | 269 | 270 | 1420 | 1709 | 1823 | 2165 | list_sessions | bot_speaking | What are my agents doing right now? | Let me check. The frontend agent is idle after finishing the… |
| 3 | 267 | 303 | 270 | 271 | 1899 | 2059 | 2163 | 2515 | dispatch_task |  | Tell the front-end agent to fix the login bug. | On it. I've sent the frontend agent the instruction to fix t… |
| 4 | 251 | 284 | 257 | 258 | 1931 | 1932 |  |  |  | agent_thinking | Which agent is the slowest one? |  |
| 5 | 254 | 294 | 256 | 257 |  |  |  |  | list_sessions | agent_thinking | Actually, never mind. | Let me check their current status. ✂ |
| 6 | 252 | 312 | 312 | 313 | 2221 | 2305 | 2433 | 2735 | list_sessions | bot_speaking | Is the back-end one still busy? | Let me check again. Yes, the backend agent is still busy run… |
| 7 | 252 | 284 | 258 | 259 |  |  |  |  |  | agent_thinking | Explain in detail. |  |
| 8 | 257 | 295 | 259 | 261 | 2076 | 2421 | 2544 | 2835 |  | bot_speaking | how you would coordinate five agents working on… | I'd split the refactor into non-overlapping areas, assign on… |
| 9 | 255 | 293 | 282 | 284 |  |  |  |  |  | agent_thinking | Sorry, stop. |  |
| 10 | 254 | 294 | 261 | 261 | 1713 | 2048 | 2154 | 2445 | list_sessions |  | Just tell me which agent needs my input. | Let me check. The docs agent needs your input. It's asking w… |
| 11 (event) |  |  |  | +0 | 1188 | 1500 | 1630 |  |  |  | [event] frontend agent finished: the login bug is fixed… | The frontend agent says the login bug is fixed and all tests… |
| 12 | 254 | 293 | 257 | 258 | 1343 | 1417 | 1534 | 1785 |  |  | Thanks, that's all for now. | You're welcome. Talk soon. |

(`bot_speaking` on turns 2/6/8: the next scripted utterance started while that reply was still
being spoken. The scenario's fixed gaps are shorter than some replies, so these are real barge-ins.)

Other runs kept for reference: `e2e-http-20261029-200447` (GPU before the trim fix),
`e2e-http-fallback-kmpc-asleep-20261029-201753` (`SPEECH_BACKEND=http` with km-pc asleep: every
request fell back to CPU, PASS), `e2e-local-timeout1.3s-20261029-202015` (timeout path).
Each dir has `server.log`, `call-*.jsonl` and `browser.json`. Re-analyze with
`uv run python -m voice_loop.analyze --run tests/out/<dir> [--run ...]`.

## Known issues

1. **The agent is the bottleneck.** The ACP prompt → first text takes 1.2–1.6 s median, with
   tails to 3+ s, and each tool call adds ~1.3 s (a second model call). Real content therefore
   arrives ~2.2–2.6 s after you stop (GPU), ~2.9 s on CPU. The ack at ~0.5 s and the filler
   make that bearable, but it is a "competent but slow" phone agent, as the spike predicted.
   Haiku TTFT also varies run to run (1.2 s vs 1.6 s medians in two otherwise identical sets).
2. **Early end of turn at mid-sentence pauses.** Smart Turn calls "Explain in detail." or
   "Sorry, stop." complete. With fast GPU STT the turn is closed and prompted within ~260 ms,
   so the rest of the sentence becomes a barge-in that cancels that prompt. Mitigation built
   in: a prompt cancelled before the agent said anything is merged into the next one
   ("Explain in detail. how you would coordinate…"), so the reply makes sense, but that path
   costs a second full prompt. The ack also plays at that pause. With CPU STT (570 ms) the user
   usually resumes before the transcript arrives, so the turn stays open. The cancelled user
   message stays in the ACP session history (the agent sees the text twice; harmless so far).
3. **GPU TTS pads every sentence** with ~350 ms of silence in front and ~500 ms behind
   (kokoro-onnx: 30–70 / 80–220 ms). Untrimmed, that measured +300 ms frame-out→heard and long
   gaps between sentences. `HttpTTSService` now trims it client-side (`SilenceTrimmer`). It
   should be fixed in `gpu-speech/tts_server.py`. The GPU server also renders "Mm-hmm." badly
   (it transcribes back as "Mammal"), so cues always come from the local kokoro-onnx.
4. **CPU fallback costs:** whisper base.en ~570 ms per utterance; kokoro-onnx 250–300 ms for
   a short sentence but up to 1.6 s for a long first sentence (no clause splitting on the CPU
   path).
5. **Interrupted replies:** Haiku writes the whole reply in < 1 s, so a barge-in usually hits
   while it is being *spoken*, after the prompt finished: nothing to cancel, and the session
   thinks the user heard everything. The next prompt is prefixed with "(I interrupted your
   previous reply.)". It doesn't say where the cut happened.
6. **Not verified from km-mbp.** The test ran headless Chromium on dev itself. Media used dev's
   tailscale addresses, and serve/https was exercised, but no real cross-machine call has been
   made. If the page connects but you hear nothing, check the "connected via …" status line (the
   selected ICE pair) and the browser console.
7. **Headset needed.** The bot's voice through laptop speakers can trigger VAD → false barge-ins
   (no echo testing was possible here).
8. One call at a time: a new call ends the previous one. `auto` backend selection happens once
   at server start; per-request CPU fallback covers a GPU that disappears, but not one that
   appears later (restart the server).
9. Timeout is per prompt (25 s), not per first chunk; a stalled prompt is silent for that long
   (after the ack/filler).

## Suggested next tweaks

1. **Talker–reasoner split** (the spike's open question): put a direct-API or local fast model
   on the turn, and keep the ACP harness for tool and agent work. That is the only lever left on
   the ~1.2–1.6 s floor; speech is now ≤ 150 ms of it on GPU.
2. **Speculative prompting:** send the prompt at the Smart Turn decision with the transcript
   so far (GPU STT is 60 ms) and cancel if the user resumes. Pipecat 1.15 has the machinery
   (`UserTurnSpeculation`, eager end-of-turn). Combined with the merge in issue 2, it saves
   the transcript wait.
3. Tune turn-taking for this speaker style: add a short grace window (e.g. 300–500 ms) after
   a "complete" decision on very short utterances before prompting, or raise Smart Turn's
   threshold. That trades ~0.3 s on short turns for fewer split turns.
4. Fix the GPU TTS padding server-side; let the TTS split long first sentences at a comma on
   the CPU path too (the GPU server already does).
5. Earlier first audio: start TTS on the first clause (comma) instead of the first sentence
   when the sentence is long; Haiku's first sentences are often 15–25 words.
6. Shorter `PROMPT_TIMEOUT_S` for the *first chunk* (e.g. 6 s → filler "Still working on
   it…"), separate from the total timeout.
7. Make a real call from km-mbp with a headset and listen for ack timing, filler choice and
   voice; try `ACK=earcon` and `ACK=off` to compare how they feel.
