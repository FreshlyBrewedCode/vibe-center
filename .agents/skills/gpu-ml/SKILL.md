---
name: gpu-ml
description: "Run Python ML workloads (PyTorch, onnxruntime, CUDA; speech models for STT, TTS, VAD, turn detection) on km-pc's RTX 3070 over `gpu ssh`. Use for any benchmark, prototype or voice-pipeline test that needs CUDA or real GPU latency numbers."
---

This project's companion to the `gpu` skill, which owns waking, `gpu status`, `gpu ssh` and
`gpu sleep`. Its browser, Blender, dev-server-port and `scripts/gpu-job.sh` sections belong to the
produce-together game; here km-pc is a headless CUDA box you drive over `gpu ssh`.

## What km-pc offers

- RTX 3070, 8 GB VRAM (~0.6 GB already held by its desktop and the shared browser), driver 595,
  CUDA 13.2; 12 cores, 15 GB RAM, ~160 GB free disk. Shared, unprivileged `gpu` user
- **no** python, uv, node, bun, ffmpeg or docker installed; `nix` works for the `gpu` user
  (flakes on), so tools come from `nix shell`
- NixOS has no regular dynamic loader: pip/uv wheels with native code (numpy, torch,
  onnxruntime) fail with `libz.so.1` / `libstdc++.so.6` not found until `LD_LIBRARY_PATH` names
  those libraries and the driver's `/run/opengl-driver/lib` (libcuda). The recipe below does
  that
- the uv cache (`~/.cache/uv`) is shared and keeps the big wheels: the first `torch` install takes
  ~4 min, later ones are quick (a whole voice-stack venv: ~40 s). Leave the cache in place

## Python environment recipe

Work in `~/vibe-center` (yours to create and clean up; other agents share the user). Every command
that runs Python goes through the same shell:

```sh
gpu wake
gpu ssh 'mkdir -p ~/vibe-center && cd ~/vibe-center && nix shell nixpkgs#python312 nixpkgs#uv nixpkgs#stdenv.cc.cc.lib nixpkgs#zlib -c bash -c "
  export LD_LIBRARY_PATH=\$(nix eval --raw nixpkgs#stdenv.cc.cc.lib)/lib:\$(nix eval --raw nixpkgs#zlib)/lib:/run/opengl-driver/lib
  [ -d .venv ] || uv venv -p \$(command -v python3) .venv
  uv pip install -p .venv torch
  .venv/bin/python -c \"import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))\"
"'
```

Verified 2026-10-29: `torch 2.15.0+cu132` sees the RTX 3070 (~21 TFLOPS fp16 matmul). For
anything beyond a one-liner, run through a wrapper script kept in the repo, like
[`services/speech-gpu/env.sh`](../../../services/speech-gpu/env.sh) (`./env.sh setup`, then
`./env.sh python …`). It sets all of the following.

- the cu13 wheels unpack to `.venv/lib/python3.12/site-packages/nvidia/cu13/lib` (one directory
  for cuBLAS, cudart, …) plus `nvidia/{cudnn,nccl,cusparselt,nvshmem}/lib`. Put every
  `nvidia/*/lib` on `LD_LIBRARY_PATH`
- `onnxruntime-gpu` 1.31 loads CUDA **13**, and its CUDA provider also needs `libcurand.so.10`,
  which torch doesn't bring: install `nvidia-curand`. Without it, ORT logs an error and silently
  runs on the CPU, so check the log. `get_available_providers()` lists CUDA either way
- a dependency that pulls the CPU `onnxruntime` (e.g. faster-whisper) shadows `onnxruntime-gpu`:
  uninstall `onnxruntime`, then `uv pip install --reinstall onnxruntime-gpu`
- faster-whisper / ctranslate2 4.8 wheels are built against CUDA **12** (`libcublas.so.12`). Give
  them their own venv with `nvidia-cublas-cu12` and `nvidia-cudnn-cu12==9.*`: the cu12 and cu13
  cuDNN wheels share `nvidia/cudnn/`
- onnxruntime ≥ 1.31 refuses models whose external weights (`*.onnx.data`) sit behind Hugging
  Face cache symlinks ("External data path escapes model directory"). Download those with
  `snapshot_download(repo, local_dir=…)`
- packages that download data with `pip` at runtime fail in uv venvs, which have no pip. Install
  the data as a requirement instead, e.g. Kokoro/misaki's spaCy model `en_core_web_sm @
  https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl`

## Measuring latency

- onnxruntime's CUDA kernels keep their setup for the **last input shape only**: a new shape
  costs ~170 ms extra on the 3070 (Parakeet: 20–35 ms repeated, ~170 ms new), whatever the
  arena or cuDNN search options. Benchmark with lengths that change, as real input does. To
  serve, pad to one fixed shape
- the GPU clocks down between requests: back-to-back loops read ~10–20 ms faster than requests
  spaced like a conversation. Measure both
- driver-reported VRAM per process (CUDA context included):
  `nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits`

## Long-lived servers

The `gpu` user has no lingering systemd user manager (`Linger=no`), so `systemd-run --user`
units would stop with the last SSH session (inferred, not tried). logind keeps processes of ended sessions (`KillUserProcesses=false`), so
start the server detached in its own session and keep a pid file:
`setsid bash -c 'echo $$ > run/x.pid; exec ./env.sh python server.py' >> logs/x.log 2>&1 < /dev/null &`.
`nix shell -c` and `exec` keep the pid, and `kill -- -<pid>` stops the whole group.
[`services/speech-gpu/`](../../../services/speech-gpu/) does this (`run.sh`), driven from dev by
`speech.sh up|status|down`, with its own ControlMaster tunnel. Its STT/TTS servers (ports
8401/8402, ~2.8 GB VRAM) are the ready-made speech stack: see its README.

## Reaching a server on km-pc

km-pc accepts SSH only. Reach a service it runs (a voice-pipeline server, a model server) through
a local forward from `dev`: `ssh -f -N -L 127.0.0.1:<port>:127.0.0.1:<port> gpu@km-pc`. A
forward carries TCP only, so pick WebSocket/HTTP transports for anything that goes through it;
whether UDP (WebRTC media) reaches km-pc over the tailnet is unverified, so check it before
relying on it.

## Sharing the GPU

- `gpu status` first: when `local user` names someone, they are at the PC (maybe gaming). Ask
  the user before loading models onto the GPU
- take the same lock as produce-together's GPU jobs so the two projects take turns:
  `flock /tmp/pt-gpu.lock <command>` on `dev` (a kernel lock, released when its holder dies)
- as a subagent, stay with a long job until it ends, checking its log, since ending your turn
  leaves the GPU loaded with nobody watching. Print a line per step so progress is visible
- when done: stop your processes on km-pc, `rm -rf` scratch data you don't need again, then
  `gpu sleep` (it leaves km-pc on if someone is using it)
