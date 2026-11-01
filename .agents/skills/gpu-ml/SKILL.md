---
name: gpu-ml
description: "This project's speech stack on the GPU host: the speech-gpu services (STT/TTS servers), their env.sh wrapper, and measuring voice-pipeline latency on the RTX 3070. Use for any benchmark, prototype or voice-pipeline test that needs CUDA or real GPU latency numbers."
---

The global `gpu` skill owns the GPU host: waking it, `gpu status`, `gpu ssh`, the shared lock,
`gpu sleep`, and (in its `python.md`) the Python/CUDA environment recipe, the onnxruntime and
CUDA 12/13 wheel gotchas, latency measuring, long-lived servers and port forwards. Read that
first; this skill adds what is specific to vibe-center.

## The environment wrapper

Run Python on the GPU host through
[`services/speech-gpu/env.sh`](../../../services/speech-gpu/env.sh) (`./env.sh setup`, then
`./env.sh python …`), working in `~/vibe-center` there. It sets every library path the `gpu`
skill's recipe lists, so commands stay one-liners.

## The speech stack

[`services/speech-gpu/`](../../../services/speech-gpu/) is the ready-made stack: STT and TTS
servers on ports 8401/8402 (~2.8 GB VRAM), started detached by `run.sh` on the GPU host and
driven from `dev` by `speech.sh up|status|down`, with its own ControlMaster tunnel. See its
README before starting a server of your own.

- faster-whisper / ctranslate2 needs its own CUDA 12 venv (the `gpu` skill's `python.md` says how)
- Kokoro/misaki downloads its spaCy model with `pip` at runtime, which fails in uv venvs: the
  model is a requirement instead
- benchmark speech models with input lengths that change, as real speech does, and with
  requests spaced like a conversation as well as back to back (`python.md`, "Measuring latency")

## When done

`speech.sh down` if you started the stack, remove scratch data under `~/vibe-center` you won't
need again, then `gpu sleep`.
