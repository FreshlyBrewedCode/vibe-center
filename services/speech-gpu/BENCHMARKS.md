# Speech model benchmarks on the GPU host (RTX 3070, 8 GB)

Measured 2026-10-29 on the GPU host: RTX 3070, driver 595 / CUDA 13.2, onnxruntime-gpu 1.31.1,
torch 2.15.0+cu132, ctranslate2 4.8.4 (CUDA 12 wheels), onnx-asr 0.12.0, kokoro 0.9.4.
Nobody was using the GPU, and the desktop held ~0.2 GB.

**Chosen defaults:** STT **Parakeet-TDT 0.6B v2 (fp16 ONNX, onnxruntime CUDA)**, TTS
**Kokoro-82M, voice `af_heart`**. Both loaded: **~2.75 GB VRAM** (STT 1.73 GB + TTS 1.02 GB
after use; GPU total 3.0 GB with the desktop).

## STT

Test clips: Kokoro `af_heart` speaking coding sentences, resampled to 16 kHz:
"Yes, merge it." (1.7 s); "Open a pull request for the vibe center repo." (3.2 s); "Check the
CI status on PR forty two, and if the tests pass, ask the agent to rebase the branch and run
the CLI smoke test again." (9.6 s). Plus a human recording: JFK's "ask not" (11 s, from
faster-whisper's test data).

Latency is the model call alone (decoded audio in, text out), warm, median of 7 back-to-back
runs of the same clip. VRAM is what the driver attributes to the process, CUDA context included.

| candidate | 1.7 s | 3.2 s | 9.6 s | 11 s (human) | VRAM | notes |
|---|---:|---:|---:|---:|---:|---|
| **Parakeet-TDT 0.6B v2, fp16** (our conversion), ORT CUDA | 16 ms | 21 ms | 34 ms | 33 ms | **1.7 GB** | all 4 correct. **New input lengths: see below** |
| Parakeet-TDT 0.6B v2, fp32 (istupakov ONNX), ORT CUDA | 18 ms | 22 ms | 40 ms | 42 ms | 3.5 GB (3.1 GB lean arena) | same transcripts as fp16 |
| Parakeet-TDT 0.6B v2, int8 (istupakov ONNX), ORT CUDA | 212 ms | 319 ms | 772 ms | 861 ms | 0.6 GB | most int8 ops fall back to the CPU (742 memcpy nodes). Not usable on GPU |
| faster-whisper large-v3-turbo, int8_float16, greedy | 154 ms | 160 ms | 191 ms | 181 ms | 1.2 GB | all correct. Whisper always pads to 30 s, so these hold for any length |
| faster-whisper distil-large-v3, int8_float16, greedy | 148 ms | 153 ms | 174 ms | 171 ms | 1.2 GB | all correct ("PR 42"); splits sentences differently |

**New lengths.** onnxruntime's CUDA kernels keep their setup (cuDNN algorithms, workspaces) for
the last input shape only. Every utterance length not seen just before costs **~170 ms**
whatever the arena or cuDNN search setting (`bench/stt_probe.py`, `bench/stt_pad.py`). In a
call every utterance has a new length, so unpadded Parakeet runs at ~170 ms, no better than
Whisper. Padding with trailing silence to one fixed length fixes it, and the transcripts stay
the same:

| Parakeet fp16, 10 random lengths 0.5–9.6 s | per request |
|---|---|
| unpadded | 157–178 ms |
| padded to 10 s | 26–33 ms |
| padded to 16 s (**server default**, `STT_PAD_SECONDS`) | 41–65 ms |
| switching between pad lengths (e.g. a 1 s clip after a 16 s one) | ~170 ms once |

16 s covers the contract's 0.5–15 s utterances with one shape.

**As served** (`bench/paced.py`, from dev through the tunnel, 2 s pause before each request
so the GPU clocks down as in a conversation, median of 7):

| clip | server (`X-Processing-Ms`, incl. WAV decode) | round trip from dev |
|---|---:|---:|
| 1.7 s | 54 ms | 61 ms |
| 3.2 s | 50 ms | 57 ms |
| 9.4 s | 52 ms | 61 ms |

Accuracy notes: every candidate transcribed all clips correctly apart from formatting. Parakeet
turns spoken numbers into digits, inconsistently: "PR forty two" became "PR42" (once, on a
padded clip, "PR forty two"), and "PR one hundred and twelve" became "PR100 and 12". "Vibe
Center" was capitalised, "Karl" became "Carl", and a 33-word two-sentence instruction
(am_michael voice) was perfect. Whisper
offers `hotwords`/`initial_prompt` biasing for repo names, Parakeet has nothing comparable.

**Why Parakeet:** padded, it is ~3× faster than the Whisper variants as served (~50 vs ~150–190
ms), at the cost of ~0.5 GB more VRAM. On the Open ASR leaderboard it is also more accurate
(6.05 % vs ~7.7 % WER for large-v3-turbo). If coding vocabulary turns out to need biasing,
faster-whisper large-v3-turbo with `hotwords` is the fallback: ~150–190 ms, 1.2 GB, no
padding needed. It needs its own venv (`requirements-whisper.txt`), because ctranslate2's
wheels are built against CUDA 12.

## TTS: Kokoro-82M

Official `kokoro` package (KPipeline, torch CUDA), voice `af_heart`, speed 1.0. Text is
synthesised one sentence at a time, and TTFA (time to first audio) is the time until the first
sentence's audio is ready. Short: "Sure, I will check the build and get back to you." (11 words).
Medium: three sentences, 34 words.

| measurement | short (11 words, 3.0 s audio) | medium (34 words, 10.8 s audio) |
|---|---:|---:|
| TTFA, back-to-back, in-process (`bench/tts_kokoro.py`) | 70 ms | 71 ms |
| total synthesis, back-to-back | 70 ms (RTF 0.023) | 222 ms (RTF 0.021) |
| TTFA from dev through the tunnel, 2 s pauses (`bench/paced.py`) | 90 ms | 79 ms |
| total from dev, 2 s pauses | 92 ms (RTF 0.031) | 235 ms (RTF 0.022) |

- VRAM: 0.9 GB in the benchmark (torch peak allocation 0.63 GB). The server, with all 28 English
  voices loaded and after a ~700-character request: 1.0 GB
- per sentence, G2P (misaki + spaCy, CPU) takes 2–3 ms and the model ~55–65 ms, and that is
  nearly fixed: "Okay." still takes ~70–80 ms. So ~80 ms TTFA is the floor here. Splitting the
  first sentence finer would not gain much
- default voice `af_heart`: the best-graded voice on Kokoro's voice list. I couldn't listen to
  it here, so pick by ear with `smoke.py --voice <name> --save out.wav`. Its output, and that of
  `am_michael` and `bm_george`, came back word for word from Parakeet, a fair proxy for
  intelligibility
- I didn't look at other TTS candidates, since Kokoro already makes ~10 s of speech in ~0.2 s

## Combined

| | VRAM |
|---|---:|
| STT server (Parakeet fp16, padded to 16 s) | 1.73 GB |
| TTS server (Kokoro, 28 voices) | 1.02 GB |
| **both** | **2.75 GB** (GPU total 3.0 GB with the desktop; ~5 GB left) |

Startup from a running GPU host: ~18 s until both `/health` answer (Kokoro ~9 s, Parakeet ~3.5 s,
plus the nix shell and warm-up). From a sleeping GPU host: ~40 s.

## STT accuracy and the model catalog (2026-10-30)

After real calls showed accuracy problems, I measured where they came from before comparing
models. Same GPU host (RTX 3070, driver 595 / CUDA 13.2, onnxruntime-gpu 1.31.1, faster-whisper
1.2 / ctranslate2 4.8 on CUDA 12, onnx-asr 0.12.0); nobody at the PC.

**Evaluation set** (`services/voice/eval`): 36 things people say to a coding agent ("Open a PR
for the auth refactor", "Ask Ben to rebase onto main", "There's a bug on line one hundred and
twelve", agent and project names: Jeff, Ben, Karl, Nova, Vibe Center, Pipecat, Tailscale, …),
290 words, 17 mid-sentence pauses of 0.35–0.9 s. Ten Kokoro voices (US/UK, female/male) at
speed 0.9–1.15, in three conditions: **clean** (-23 dBFS), **noisy** (pink noise at 15 dB SNR
plus babble of other utterances at 18 dB), **phone** (300–3400 Hz, -38 dBFS, brown noise at
20 dB). Each clip runs through Pipecat's Silero VAD in 20 ms frames, as in a call, and is
transcribed the old way (**segments**: each VAD segment alone) and the new way (**turn**: the
whole turn). WER after normalising case, punctuation and numbers ("PR42" = "PR forty two").
870 words in all, so 0.1 % is one word.

### Root causes

1. **The pipeline cut turns into fragments** (the main one). Pipecat's `SegmentedSTTService`
   sends each VAD segment to the STT on its own: every pause over the VAD's 0.2 s stop starts a
   new segment, transcribed without the words around it, and between segments it keeps only the
   last second of audio, so speech the VAD doesn't flag (soft or short words) is dropped. The
   user's own call log showed it: one request (about the weather this weekend, judging by the
   next turns) came out as three, "Can you trick the" + "For this weekend in" + "Um", with
   "weather" gone. Fix in the
   voice worker (`turns.py`): the STT gets the whole turn (first speech to now, pauses
   included) at every VAD stop, and the new transcript replaces the old.
2. **The STT server told Parakeet the padded length.** It pads every utterance to 16 s (one
   input shape for onnxruntime's CUDA kernels, see above) and passed that as the audio length,
   so the per-feature normalisation averaged over mostly silence and the decoder ran over all
   of it. Now the real length goes in with the padded audio: same shape and speed, same
   transcripts as unpadded.

Parakeet v2 fp16 on the GPU, in-process (`bench/stt_eval.py`), WER %:

| configuration | clean | noisy | phone | all | median |
|---|---:|---:|---:|---:|---:|
| **before**: segments, padded length (as served until now) | 5.9 | 15.2 | 10.0 | **10.3** | 46 ms |
| whole turn, padded length | 2.1 | 13.1 | 4.1 | 6.4 | 46 ms |
| **after**: whole turn, real length | 0.7 | 3.8 | 4.5 | **3.0** | 33 ms |
| whole turn, unpadded (reference) | 0.7 | 3.8 | 4.5 | 3.0 | 166 ms (new shape each time) |
| whole turn, fp32, real length | 0.7 | 3.8 | 4.1 | 2.9 | 41 ms (3.0 GB VRAM) |

The same fix on every model, as served (segments → turn, all conditions): Parakeet v2 11.1 →
3.0 %, Whisper turbo 11.6 → 3.6 %, Canary 13.7 → 3.7 %, the worker's CPU Whisper base.en 15.2 →
7.1 %. Noise suffers most from fragments (Parakeet v2: 25.2 → 3.8 %).

**Measured and not a cause:**

- fp16: 3.0 vs 2.9 % for fp32 (one word)
- VAD loudness gate and pre-roll: `min_volume` 0.6/0.45/0.3 × pre-roll 1.0/1.5 s gave 2.9–3.1 %.
  Pipecat's defaults stay (now `VAD_MIN_VOLUME`, `STT_PREROLL_S` in the worker)
- the WebRTC path (Chromium fake mic with echo cancellation, noise suppression and AGC on → Opus
  → aiortc → libswresample to 16 kHz), from the e2e call's debug recordings: all 5 turns
  transcribed exactly; speech level within 0.5 dB of the source except the first turn (+6.6 dB,
  AGC settling, 1 clipped sample); -1 to -4 dB above 3 kHz relative to 1–2 kHz; the speech
  starts ~0.65 s into each recording, so the pre-roll covers the VAD's onset delay
- phone-mic processing could not be measured here (no phone). The new "Keep recordings of
  recent turns" setting keeps what the STT heard, to check real misrecognitions

What's left: in the quiet band-limited "phone" condition the VAD misses some soft words
("Sorry, stop." before "Just say goodbye.", a trailing "of the server file"), which no model can
recover; and Parakeet spells unknown names by ear ("Carl", "PipeCat").

### The models

As served (HTTP through the tunnel; eval set in turn mode). Paced = 2 s between requests, the
GPU clocking down as in a conversation (`bench/paced.py`, language `en` as the worker sends it).
Vocabulary terms = how many of the 33 occurrences of the vocabulary names came out right.

| model | clean | noisy | phone | **all** | with vocabulary | vocab terms | server, back-to-back | server, paced 1 / 2.5 / 8 s | VRAM | disk |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **Parakeet TDT 0.6B v2** (default) | 0.7 | 3.8 | 4.5 | **3.0** | n/a | 26 | 33 ms | 28 / 46 / 59 ms | 1.70 GB | 1.25 GB |
| Parakeet TDT 0.6B v3 | 0.7 | 30.7 | 5.5 | 12.3 | n/a | 25 | 35 ms | 37 / 54 / 64 ms | 1.73 GB | 1.25 GB |
| Whisper large-v3 turbo (int8_float16, greedy) | 1.7 | 3.1 | 5.9 | 3.6 | **2.9** | 26 → **31** | 160 ms | 169 / 179 / 210 ms | 1.23 GB | 1.55 GB + 2.6 GB runtime |
| Canary 1B v2 (fp16 encoder) | 1.7 | 4.1 | 5.2 | 3.7 | n/a | 29 | 77 ms | 56 / 94 / 198 ms | 3.16 GB | 2.22 GB |
| Distil-Whisper large-v3 (dropped) | 3.4 | 9.0 | 9.3 | 7.2 | 6.6 | 24 → 25 | 156 ms | 165 / 171 / 196 ms | 1.16 GB | 1.45 GB |

- **Parakeet v2 stays the default**: the lowest WER without help, and 4–5x faster than Whisper,
  which adds ~150 ms to every turn. Switch to **Whisper turbo** when names and jargon matter
  (with the custom vocabulary as hotwords it got 31 of 33 terms and 2.9 % WER) or for another
  language
- **Parakeet v3** transcribes the quieter background talk in the babble ("Ask change for the
  piece. Open a PR for the auth refactor.") and lost the speaker twice. Fine in a quiet room
  for its 25 languages; Canary or Whisper otherwise
- **Canary 1B v2** is as accurate as Whisper without the vocabulary and robust in noise, at
  ~2x Parakeet's VRAM. It doesn't detect the language: Settings → Voice → language
- **Distil-Whisper** added nothing over turbo (worse and English-only at the same speed), so
  it isn't in the catalog
- Whisper's language detection costs ~140 ms per request (paced 310 vs 170 ms): the worker
  sends the language from Settings unless it is "Detect automatically"
- `initial_prompt` instead of `hotwords` was not compared; `hotwords` is what the server uses
- switching (`POST …/activate`) took 4–6 s with the old model serving meanwhile. Downloads over
  plain HTTP ran at 6–9 MB/s (Parakeet ~5 min including the fp16 conversion)

**The CPU fallback on dev** (6 cores, shared with the app): the worker's faster-whisper
base.en int8 gets 4.1 / 6.2 / 11.0 → **7.1 %** in turn mode, and 2.8 / 5.5 / 8.3 → 5.5 % with
the vocabulary as hotwords (20 → 32 of 33 terms), at ~525–560 ms per turn. Parakeet v2 int8 on onnx-asr CPU
was 0.7 / 13.1 / 5.9 → 6.6 % at ~193 ms: faster, but weaker in noise and without vocabulary, so
the fallback stays Whisper base.en.
