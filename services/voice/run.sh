#!/usr/bin/env bash
# Run the voice worker (or a command in its environment). The app starts it this way in
# managed mode; for a remote worker run it by hand on that machine.
#   ./run.sh                 start the worker (env: VC_WORKER_TOKEN required, see voice_worker/config.py)
#   ./run.sh check           ruff + pytest (also the speech server's unit tests, ../speech-gpu/tests)
#   ./run.sh <cmd...>        run a command in the venv, e.g. ./run.sh python -m voice_worker.analyze
# uv comes from PATH, else from nix (linked as .uv). The venv is synced on every start (fast
# when nothing changed).
set -euo pipefail
cd "$(dirname "$0")"

UV=$(command -v uv || true)
if [ -z "$UV" ]; then
  [ -x .uv/bin/uv ] || nix build nixpkgs#uv -o .uv >&2
  UV=$PWD/.uv/bin/uv
fi
"$UV" sync --frozen --quiet >&2

case "${1:-}" in
  "") exec "$UV" run --frozen --no-sync python -m voice_worker ;;
  check)
    "$UV" run --frozen --no-sync ruff check .
    "$UV" run --frozen --no-sync ruff format --check .
    "$UV" run --frozen --no-sync pytest -q
    # the GPU speech server's API against fake models: same deps (fastapi, numpy, soundfile, soxr)
    exec "$UV" run --frozen --no-sync pytest -q -p no:cacheprovider ../speech-gpu/tests ;;
  *) exec "$UV" run --frozen --no-sync "$@" ;;
esac
