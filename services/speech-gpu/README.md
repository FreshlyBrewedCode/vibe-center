# speech-gpu: local STT + TTS on km-pc

Speech-to-text and text-to-speech servers for Vibe Center's voice calls (the default STT/TTS
URLs of the voice worker, `services/voice`). They run on
km-pc's RTX 3070, and `dev` reaches them through SSH local forwards on the same ports.

| | port | endpoint | model |
|---|---|---|---|
| STT | 8401 | `POST /v1/audio/transcriptions` | the active model of a catalog (below); default NVIDIA Parakeet-TDT 0.6B v2, fp16 ONNX on onnxruntime CUDA |
| TTS | 8402 | `POST /v1/audio/speech` | Kokoro-82M, official `kokoro` package on torch CUDA, voice `af_heart`. English |

Numbers and the reasons for these choices are in [BENCHMARKS.md](BENCHMARKS.md). In short:
Parakeet takes ~30–60 ms in the server for any utterance up to 16 s (3.0 % WER on the eval
set), and TTS's first audio arrives after ~80 ms. Together they use ~2.7 GB of VRAM.

**STT models** (`catalog.py`; only the default is downloaded up front, the rest when someone
picks it in Settings → Voice or through the API):

| model | languages | WER (eval set) | server time | VRAM | disk | custom vocabulary |
|---|---|---:|---:|---:|---:|---|
| **Parakeet TDT 0.6B v2** (default) | English | **3.0 %** | ~30–60 ms | 1.7 GB | 1.25 GB | no |
| Parakeet TDT 0.6B v3 | 25 European, detected | 12.3 % (transcribes background talk) | ~35–65 ms | 1.7 GB | 1.25 GB | no |
| Whisper large-v3 turbo | 99, or detected | 3.6 %, 2.9 % with vocabulary | ~170–210 ms | 1.2 GB | 1.5 GB (+2.6 GB CUDA 12 runtime) | yes (hotwords) |
| Canary 1B v2 | 25 European, set in Settings | 3.7 % | ~55–200 ms | 3.2 GB | 2.2 GB | no |

## Use it from dev

```sh
services/speech-gpu/speech.sh up        # wake km-pc, sync, start, open tunnels (~20 s awake, ~40 s from sleep; first run on a fresh km-pc: minutes)
services/speech-gpu/smoke.py            # TTS -> STT round trip through the tunnels; prints timings, PASS/FAIL
services/speech-gpu/speech.sh status    # servers (pid, VRAM), tunnel, /health of both ports
services/speech-gpu/speech.sh logs tts  # tail a server's log (stt|tts) [lines]
services/speech-gpu/speech.sh restart   # after changing server code
services/speech-gpu/speech.sh down      # stop servers, close tunnels
gpu sleep                                # when nothing else needs km-pc
```

The app can run `up`, `status` and `down` too: Settings → Voice → "Start GPU speech" (it shows
the script's output; `gpu sleep` stays manual). Calls pick the GPU servers when their `/health`
answers at call start, else the worker's CPU models.

- `up` is idempotent: servers that already run are left alone, and an open tunnel is reused. It
  reinstalls the venv only when `requirements.txt` or `env.sh` changed
- `up` refuses when someone sits at km-pc (`gpu status` → `local user`), since the models take
  ~2.7 GB of their GPU (more with Canary). Ask them first, then `speech.sh up --force`
- the servers don't take the produce-together GPU lock (`/tmp/pt-gpu.lock`): they hold VRAM but
  are idle between requests. Run `speech.sh down` before long GPU benchmarks
- the tunnel is a ControlMaster socket at `$XDG_RUNTIME_DIR/gpu-speech-tunnel.sock`, separate
  from `gpu`'s tunnels: `gpu close` leaves it alone. `gpu sleep` suspends km-pc under running
  servers, so `speech.sh down` first

## Interface

**STT** `POST http://127.0.0.1:8401/v1/audio/transcriptions`, OpenAI-style multipart:

- `file`: WAV (also FLAC/OGG), any sample rate (resampled to 16 kHz), stereo is averaged.
  Expected: 16 kHz mono s16le, 0.5–15 s
- `language`: optional ISO code. Whisper and Canary use it (Whisper detects it when absent, for
  ~140 ms; Canary assumes English); Parakeet ignores it (v3 detects the language itself)
- `prompt`: the custom vocabulary ("Jeff, Vibe Center, Pipecat"). Whisper uses it as `hotwords`;
  the others ignore it. `model`, `temperature`: accepted, ignored (the active model serves)
- `response_format`: `json` (default) → `{"text": "..."}`; `text` → plain text; `verbose_json`
  adds `language`, `duration` and `model`
- response headers `X-Processing-Ms` (time spent in the server) and `X-Model`
- audio under 0.1 s → `{"text": ""}`; no model loaded (or one being switched in with no
  room for both) → 503, and the voice worker falls back to its CPU Whisper for that turn

```sh
curl -s localhost:8401/v1/audio/transcriptions -F file=@utt.wav    # {"text":"Open a pull request for the Vibe Center repo."}
```

**STT models** (the app proxies these for Settings → Voice):

| | |
|---|---|
| `GET /v1/stt/models` | `{active, loading, default, models: [...], runtimes}`; each model: catalog fields (name, languages, `accuracy` note, `latency_ms`, `vram_mb`, `wer`, `download_mb`, `supports_vocabulary`, `recommended`), `status` (`absent`/`downloading`/`ready`/`loading`/`active`), `progress` (`phase` runtime/download/convert, bytes, `fraction`), `disk_mb`, `error` |
| `POST /v1/stt/models/{id}/download` | 202; starts the download (a Whisper model first installs the CUDA 12 runtime) |
| `DELETE /v1/stt/models/{id}/download` | cancels it; the partial files are removed |
| `POST /v1/stt/models/{id}/activate` | 202; loads it, warms it up, then swaps it in (hot, no restart); 409 when not downloaded |
| `DELETE /v1/stt/models/{id}` | deletes its files (409 for the active one); the last Whisper takes the CUDA 12 runtime with it |

```sh
curl -s localhost:8401/v1/stt/models | jq '.models[] | {id, status, disk_mb}'
curl -s -X POST localhost:8401/v1/stt/models/whisper-large-v3-turbo/download
curl -s -X POST localhost:8401/v1/stt/models/whisper-large-v3-turbo/activate
```

**TTS** `POST http://127.0.0.1:8402/v1/audio/speech`, OpenAI-style JSON:

- `input` (required), `voice` (default `af_heart`), `speed` 0.5–2.0 (default 1.0), `model` ignored
- `response_format`: `pcm` (default): raw **s16le mono 24000 Hz**, chunked; `wav`: the same
  with a streaming WAV header in front (sizes set to 0xFFFFFFFF)
- streamed one chunk per sentence, each trimmed to ~30 ms of silence before and ~120 ms after
  (Kokoro pads ~350 / ~500 ms; `TTS_TRIM=0` keeps it): the text is split at `.!?…` and line breaks, and a first
  sentence over 12 words also at its first comma/semicolon/colon/dash, so the first audio
  comes after ~80 ms whatever the length. Headers `X-Sample-Rate: 24000`, `X-Audio-Format: s16le-mono`
- closing the connection mid-stream (barge-in) stops synthesis after the current sentence
- unknown voice, bad format or speed, empty input → 400

`GET /v1/audio/voices` (or `/voices`) → `{"voices": [...], "default": "af_heart"}`: the 28 English
voices, `a*` American and `b*` British (`af_` = female, `am_` = male).

Both: `GET /health` → 200 `{"status": "ok", ...}` once the model is loaded and warmed up. Until
then the port refuses connections. STT also has `GET /v1/models`.

## How it runs on km-pc

- code in `~/vibe-center/gpu-speech` (synced by `up`; the remote name predates the move to
  `services/speech-gpu` and is kept so the venv and models there are reused), venv `.venv` there, STT models in
  `~/.cache/gpu-speech/models/<id>/` (`.complete` once usable; `state.json` names the model to
  serve after a restart) and Kokoro in `~/.cache/huggingface`
- the STT server (`stt_server.py`) is a light front: HTTP, the catalog (`models.py`) and
  downloads. Each model runs in its own child process (`stt_backend.py`, newline-delimited JSON
  plus raw float32 audio over stdin/stdout) in its runtime's venv: `.venv` (onnxruntime, CUDA 13)
  for Parakeet and Canary, `.venv-whisper` (ctranslate2, CUDA 12, from `requirements-whisper.txt`)
  for Whisper. The two CUDA stacks can't share a process, and stopping a process is the reliable
  way to give its VRAM back. Activating starts the new backend, waits until it has warmed up,
  swaps it in and stops the old one; only when both wouldn't fit (`STT_VRAM_BUDGET_MB`, 6000)
  is the old one stopped first
- a download is a `fetch.py` subprocess (cancel kills it): `snapshot_download` into the model's
  directory over plain HTTP (`HF_HUB_DISABLE_XET`: Xet fetched ~1.3 MB/s here against ~6–9 MB/s,
  and only wrote the file at the end, so there was no progress to show), then for Parakeet and
  Canary the fp16 conversion of the encoder (`parakeet_fp16.py`, ~30 s); the fp32 weights are
  deleted after it
- `env.sh` runs a command with Python 3.12 + uv from `nix shell` and `LD_LIBRARY_PATH` set to
  libstdc++/zlib, the cu13 CUDA wheels in the venv and the driver's libcuda (see the `gpu-ml`
  skill). `./env.sh setup` builds the venv
- `prepare.py` downloads the default STT model (unless some catalog model is there; it also
  moves a Parakeet from before the catalog into place) and Kokoro. fp16 halves Parakeet's VRAM
  and is faster, with the same WER as fp32 on the eval set (3.0 vs 2.9 %)
- `run.sh start|stop|status|logs` runs each server as its own session (`setsid`), with its pid in
  `run/` and its log in `logs/`. They outlive the SSH session because logind keeps processes of
  ended sessions (`KillUserProcesses=false`). Not `systemd-run --user`: the `gpu` user has no
  lingering user manager, so its units would stop with the last SSH session
- servers bind 127.0.0.1 only

## Caveats

- Parakeet and Canary: onnxruntime's CUDA kernels keep their setup for the last input shape
  only, and a new length costs ~170 ms. The backend therefore pads every utterance with silence
  to a multiple of 16 s (`STT_PAD_SECONDS`), so all normal utterances share one shape, and passes
  the real length, so the model normalises and decodes only the speech (until 2026-10-30 it
  passed the padded length, which cost accuracy: BENCHMARKS.md). Longer audio (16–32 s) pays
  ~170 ms on its first request and again on the next short one
- Parakeet has no hotword/prompt biasing. It writes numbers as digits ("PR forty two" →
  "PR42") and spells unknown names by ear ("Karl" → "Carl", "Pipecat" → "PipeCat"). Whisper
  with the vocabulary gets those right; it is ~4x slower
- Parakeet v3 transcribes quieter background talk too (12.3 % WER, 30.7 % in the babble
  condition). Pick it for a quiet room in another language; Canary or Whisper otherwise
- one model serves everyone: switching it switches it for every app and agent using the server
- the GPU clocks down between requests. That is in the "paced" numbers in BENCHMARKS.md;
  back-to-back requests run ~10–20 ms faster
- one request at a time per server on the GPU (a lock). Concurrent requests queue, which is fine
  for one call
- `.venv-whisper` (`requirements-whisper.txt`) is installed with the first Whisper download and
  deleted with the last Whisper model; the shared uv cache makes a reinstall quick

## Benchmarks

`bench/` has the scripts behind BENCHMARKS.md. Run them on km-pc from `~/vibe-center/gpu-speech/bench`
with `../env.sh python <script>`, after copying `bench/` (and, for Whisper, `requirements-whisper.txt`) over. `tts_kokoro.py` writes the test clips
to `/tmp/gpu-speech-bench/`, which `stt.py <parakeet|parakeet-fp16|parakeet-int8|whisper-turbo|whisper-distil>` reads.
`paced.py` runs on dev against the live servers.

The accuracy numbers come from the voice worker's evaluation set (`services/voice/eval`): on dev,
`./run.sh python -m eval.run --stt http://127.0.0.1:8401 [--vocab]` measures the active model
as served, through the call pipeline's segmentation. For in-process variants on km-pc
(precision, padding), `./run.sh python -m eval.export` on dev, copy `eval/out/export` and
`eval/wer.py` to `/tmp/stt-eval` there, then `./env.sh python bench/stt_eval.py <model-id>
<model-dir> [--fp32]` from `~/vibe-center/gpu-speech`.
