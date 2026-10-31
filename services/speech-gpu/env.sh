#!/usr/bin/env bash
# Run a command on the GPU host with Python + CUDA libraries reachable (NixOS has no
# global dynamic loader). Usage (from any directory):
#   ./env.sh setup             create/refresh .venv from requirements.txt
#   ./env.sh python foo.py     anything else runs inside the environment
# VENV=.venv-whisper selects another venv (setup then reads requirements-whisper.txt)
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
VENV=${VENV:-.venv}

if [ -z "${GPU_SPEECH_NIX:-}" ]; then
  export GPU_SPEECH_NIX=1
  exec nix shell nixpkgs#python312 nixpkgs#uv -c "$DIR/env.sh" "$@"
fi

# libstdc++/zlib for native wheels, libcuda from the driver
if [ ! -s "$DIR/.nixlibs" ] || [ ! -d "$(head -1 "$DIR/.nixlibs")" ]; then
  nix build --no-link --print-out-paths nixpkgs#stdenv.cc.cc.lib nixpkgs#zlib > "$DIR/.nixlibs"
fi
LIBS=$(sed 's|$|/lib|' "$DIR/.nixlibs" | paste -sd:)
# CUDA runtime libraries shipped as pip wheels (cu13 in .venv for
# torch/onnxruntime; cu12 in .venv-whisper for ctranslate2)
for d in "$DIR/$VENV"/lib/python3.12/site-packages/nvidia/*/lib; do
  [ -d "$d" ] && LIBS="$LIBS:$d"
done
export LD_LIBRARY_PATH="$LIBS:/run/opengl-driver/lib"
export HF_HOME="$HOME/.cache/huggingface" HF_HUB_DISABLE_PROGRESS_BARS=1

if [ "${1:-}" = setup ]; then
  cd "$DIR"
  [ -d "$VENV" ] || uv venv -q -p "$(command -v python3)" "$VENV"
  uv pip install -q -p "$VENV" -r "requirements${VENV#.venv}.txt"
  # a CPU-only onnxruntime pulled in as a dependency shadows onnxruntime-gpu
  if uv pip show -q -p "$VENV" onnxruntime-gpu 2>/dev/null && uv pip show -q -p "$VENV" onnxruntime 2>/dev/null; then
    uv pip uninstall -q -p "$VENV" onnxruntime
    uv pip install -q -p "$VENV" --reinstall onnxruntime-gpu
  fi
  exit 0
fi
[ -d "$DIR/$VENV" ] && export PATH="$DIR/$VENV/bin:$PATH"
exec "$@"
