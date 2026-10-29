# Speech model benchmarks on km-pc (RTX 3070, 8 GB)

Measured 2026-10-29 on km-pc: RTX 3070, driver 595 / CUDA 13.2, onnxruntime-gpu 1.31.1,
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

Startup from a running km-pc: ~18 s until both `/health` answer (Kokoro ~9 s, Parakeet ~3.5 s,
plus the nix shell and warm-up). From a sleeping km-pc: ~40 s.
