#!/usr/bin/env bash
# Start the voice loop on dev and publish it on the tailnet over https (needed for mic access).
#   ./run.sh            speech backend auto: GPU servers on km-pc if healthy, else local CPU
#   ./run.sh local      force the CPU fallbacks (faster-whisper + kokoro-onnx on dev)
#   ./run.sh http       force the GPU servers (start them first: ../gpu-speech/speech.sh up)
# Open https://dev.taild544b4.ts.net:7443/ on km-mbp (Chrome, headset). Ctrl+C stops everything.
set -euo pipefail
cd "$(dirname "$0")"

export SPEECH_BACKEND="${1:-${SPEECH_BACKEND:-auto}}"
export PORT="${PORT:-7860}"
HTTPS_PORT="${HTTPS_PORT:-7443}"   # 443 and 8443 are already served on dev

UV=$(command -v uv || true)
if [ -z "$UV" ]; then
  [ -x .uv/bin/uv ] || nix build nixpkgs#uv -o .uv
  UV=$PWD/.uv/bin/uv
fi
[ -d .venv ] || "$UV" sync
[ -d agent/node_modules ] || (cd agent && bun install)

cleanup() {
  [ -n "${TS_PID:-}" ] && kill "$TS_PID" 2>/dev/null || true
  [ -n "${APP_PID:-}" ] && kill -INT "$APP_PID" 2>/dev/null && wait "$APP_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

"$UV" run python -m voice_loop.server &
APP_PID=$!
# foreground `tailscale serve` (no --bg): the https listener disappears when this script exits
tailscale serve --https="$HTTPS_PORT" "http://127.0.0.1:$PORT" &
TS_PID=$!

echo "waiting for the server (models, warm ACP session)..."
until curl -sf "http://127.0.0.1:$PORT/status" 2>/dev/null | grep -q '"talker_pool":"ready"'; do
  kill -0 "$APP_PID" 2>/dev/null || { echo "server exited"; exit 1; }
  sleep 1
done
curl -s "http://127.0.0.1:$PORT/status"; echo
echo
echo "  open on km-mbp:  https://$(tailscale status --json | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1):$HTTPS_PORT/"
echo "  inject an event: curl -X POST localhost:$PORT/event -H 'content-type: application/json' -d '{\"text\":\"frontend agent finished: tests pass\"}'"
echo "  latency summary: $UV run python -m voice_loop.analyze"
echo
wait "$APP_PID"
