# gpu-speech: local STT + TTS on km-pc

Speech-to-text and text-to-speech servers for the voice "manager agent" prototype. They run on
km-pc's RTX 3070, and `dev` reaches them through SSH local forwards on the same ports. English only.

| | port | endpoint | model |
|---|---|---|---|
| STT | 8401 | `POST /v1/audio/transcriptions` | NVIDIA Parakeet-TDT 0.6B v2, fp16 ONNX on onnxruntime CUDA |
| TTS | 8402 | `POST /v1/audio/speech` | Kokoro-82M, official `kokoro` package on torch CUDA, voice `af_heart` |

Numbers and the reasons for these choices are in [BENCHMARKS.md](BENCHMARKS.md). In short:
STT takes ~50 ms in the server for any utterance up to 16 s, and TTS's first audio arrives
after ~80 ms (both ~60–90 ms from dev). Together they use ~2.8 GB of VRAM.

## Use it from dev

```sh
prototype/gpu-speech/speech.sh up        # wake km-pc, sync, start, open tunnels (~20 s awake, ~40 s from sleep; first run on a fresh km-pc: minutes)
prototype/gpu-speech/smoke.py            # TTS -> STT round trip through the tunnels; prints timings, PASS/FAIL
prototype/gpu-speech/speech.sh status    # servers (pid, VRAM), tunnel, /health of both ports
prototype/gpu-speech/speech.sh logs tts  # tail a server's log (stt|tts) [lines]
prototype/gpu-speech/speech.sh restart   # after changing server code
prototype/gpu-speech/speech.sh down      # stop servers, close tunnels
gpu sleep                                # when nothing else needs km-pc
```

- `up` is idempotent: servers that already run are left alone, and an open tunnel is reused. It
  reinstalls the venv only when `requirements.txt` or `env.sh` changed
- `up` refuses when someone sits at km-pc (`gpu status` → `local user`), since the models take
  ~2.8 GB of their GPU. Ask them first, then `speech.sh up --force`
- the servers don't take the produce-together GPU lock (`/tmp/pt-gpu.lock`): they hold VRAM but
  are idle between requests. Run `speech.sh down` before long GPU benchmarks
- the tunnel is a ControlMaster socket at `$XDG_RUNTIME_DIR/gpu-speech-tunnel.sock`, separate
  from `gpu`'s tunnels: `gpu close` leaves it alone. `gpu sleep` suspends km-pc under running
  servers, so `speech.sh down` first

## Interface

**STT** `POST http://127.0.0.1:8401/v1/audio/transcriptions`, OpenAI-style multipart:

- `file`: WAV (also FLAC/OGG), any sample rate (resampled to 16 kHz), stereo is averaged.
  Expected: 16 kHz mono s16le, 0.5–15 s
- `language`: optional; anything not `en*` → 400. `model`, `prompt`, `temperature`: accepted, ignored
- `response_format`: `json` (default) → `{"text": "..."}`; `text` → plain text; `verbose_json`
  adds `language` and `duration`
- response header `X-Processing-Ms`: time spent in the server
- audio under 0.1 s → `{"text": ""}`

```sh
curl -s localhost:8401/v1/audio/transcriptions -F file=@utt.wav    # {"text":"Open a pull request for the Vibe Center repo."}
```

**TTS** `POST http://127.0.0.1:8402/v1/audio/speech`, OpenAI-style JSON:

- `input` (required), `voice` (default `af_heart`), `speed` 0.5–2.0 (default 1.0), `model` ignored
- `response_format`: `pcm` (default): raw **s16le mono 24000 Hz**, chunked; `wav`: the same
  with a streaming WAV header in front (sizes set to 0xFFFFFFFF)
- streamed one chunk per sentence: the text is split at `.!?…` and line breaks, and a first
  sentence over 12 words also at its first comma/semicolon/colon/dash, so the first audio
  comes after ~80 ms whatever the length. Headers `X-Sample-Rate: 24000`, `X-Audio-Format: s16le-mono`
- closing the connection mid-stream (barge-in) stops synthesis after the current sentence
- unknown voice, bad format or speed, empty input → 400

`GET /v1/audio/voices` (or `/voices`) → `{"voices": [...], "default": "af_heart"}`: the 28 English
voices, `a*` American and `b*` British (`af_` = female, `am_` = male).

Both: `GET /health` → 200 `{"status": "ok", ...}` once the model is loaded and warmed up. Until
then the port refuses connections. STT also has `GET /v1/models`.

## How it runs on km-pc

- code in `~/vibe-center/gpu-speech` (synced by `up`), venv `.venv` there, models in
  `~/.cache/gpu-speech/` (Parakeet) and `~/.cache/huggingface` (Kokoro)
- `env.sh` runs a command with Python 3.12 + uv from `nix shell` and `LD_LIBRARY_PATH` set to
  libstdc++/zlib, the cu13 CUDA wheels in the venv and the driver's libcuda (see the `gpu-ml`
  skill). `./env.sh setup` builds the venv
- `prepare.py` downloads the models. It also converts Parakeet's 2.4 GB fp32 encoder to fp16
  once (`parakeet_fp16.py`, ~30 s): that halves its VRAM and is slightly faster, with the same
  transcripts
- `run.sh start|stop|status|logs` runs each server as its own session (`setsid`), with its pid in
  `run/` and its log in `logs/`. They outlive the SSH session because logind keeps processes of
  ended sessions (`KillUserProcesses=false`). Not `systemd-run --user`: the `gpu` user has no
  lingering user manager, so its units would stop with the last SSH session
- servers bind 127.0.0.1 only

## Caveats

- Parakeet: onnxruntime's CUDA kernels keep their setup for the last input shape only, and a new
  length costs ~170 ms. The server therefore pads every utterance with silence to a multiple of
  16 s (`STT_PAD_SECONDS`), so all normal utterances share one shape. Longer audio (16–32 s)
  pays ~170 ms on its first request and again on the next short one
- Parakeet has no hotword/prompt biasing (the `prompt` field is ignored). It writes numbers as
  digits ("PR forty two" → "PR42", "one hundred and twelve" → "100 and 12") and spells unknown
  names by ear ("Karl" → "Carl"). Repo names, "PR", "CLI", "CI", "diff" and "rebase" came through
  fine in the tests
- the GPU clocks down between requests. That is in the "paced" numbers in BENCHMARKS.md;
  back-to-back requests run ~10–20 ms faster
- one request at a time per server on the GPU (a lock). Concurrent requests queue, which is fine
  for one call
- `requirements-whisper.txt` / `.venv-whisper` (`VENV=.venv-whisper ./env.sh setup`) exist only
  to rerun the faster-whisper comparison in `bench/`; the servers don't use them

## Benchmarks

`bench/` has the scripts behind BENCHMARKS.md. Run them on km-pc from `~/vibe-center/gpu-speech/bench`
with `../env.sh python <script>`, after copying `bench/` (and, for Whisper, `requirements-whisper.txt`) over. `tts_kokoro.py` writes the test clips
to `/tmp/gpu-speech-bench/`, which `stt.py <parakeet|parakeet-fp16|parakeet-int8|whisper-turbo|whisper-distil>` reads.
`paced.py` runs on dev against the live servers.
