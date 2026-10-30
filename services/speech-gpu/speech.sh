#!/usr/bin/env bash
# Run the speech servers on km-pc's GPU and reach them from here (dev):
#   speech.sh up [--force]   wake km-pc, sync code, set up venv+models, start servers, open tunnels
#   speech.sh status         servers, tunnels, GPU memory
#   speech.sh down           stop the servers, close the tunnels (km-pc stays awake: `gpu sleep`)
#   speech.sh restart        down + up (after changing server code)
#   speech.sh logs [stt|tts] [lines]
# STT: http://127.0.0.1:8401  POST /v1/audio/transcriptions   (the active model; /v1/stt/models)
# TTS: http://127.0.0.1:8402  POST /v1/audio/speech → s16le 24 kHz (Kokoro-82M)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
HOST="${GPU_HOST:-km-pc}"
REMOTE_DIR=vibe-center/gpu-speech           # relative to the gpu user's home
PORTS=(8401 8402)
CTL="${XDG_RUNTIME_DIR:-/tmp}/gpu-speech-tunnel.sock"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=4 -o StrictHostKeyChecking=accept-new)
FILES=(env.sh run.sh requirements.txt requirements-whisper.txt common.py catalog.py models.py fetch.py prepare.py
       parakeet_fp16.py stt_backend.py stt_server.py tts_server.py)

remote() { gpu ssh "$@"; }
tunnel_open() { [ -S "$CTL" ] && ssh -S "$CTL" -O check "gpu@$HOST" 2>/dev/null; }
healthy() { curl -sf -m 2 "http://127.0.0.1:$1/health" >/dev/null; }

open_tunnel() {
  tunnel_open && return 0
  rm -f "$CTL"
  local fwd=() p
  for p in "${PORTS[@]}"; do fwd+=(-L "127.0.0.1:$p:127.0.0.1:$p"); done
  ssh "${SSH_OPTS[@]}" -f -N -M -S "$CTL" -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
    "${fwd[@]}" "gpu@$HOST" ||
    { echo "could not open the tunnels: is something else listening on 127.0.0.1:${PORTS[*]}?" >&2; exit 1; }
}

close_tunnel() {
  if [ -S "$CTL" ]; then ssh -S "$CTL" -O exit "gpu@$HOST" 2>/dev/null || true; fi
  rm -f "$CTL"
}

up() {
  local st
  st=$(gpu status || true)  # exits 1 when no browser tunnel is open
  if ! grep -q 'up (NixOS)' <<<"$st"; then gpu wake; st=$(gpu status || true); fi
  who=$(sed -n 's/^local user: //p' <<<"$st")
  if [ -n "$who" ] && [ "$who" != none ] && [ "${1:-}" != --force ]; then
    echo "$who is using km-pc locally; not loading models onto their GPU (~3 GB VRAM)." >&2
    echo "Ask them, then rerun with --force." >&2
    exit 1
  fi
  echo "syncing code to km-pc:~/$REMOTE_DIR"
  (cd "$HERE" && tar c "${FILES[@]}") | remote "mkdir -p ~/$REMOTE_DIR && tar x -m -C ~/$REMOTE_DIR"
  # venv + models: only when requirements changed or the models are missing (first run: a few minutes)
  remote "cd ~/$REMOTE_DIR && h=\$(sha1sum requirements.txt env.sh | sha1sum | cut -c1-12) &&
    if [ \"\$(cat .venv/.req-hash 2>/dev/null)\" != \"\$h\" ]; then
      echo 'setting up the venv'; ./env.sh setup && echo \$h > .venv/.req-hash; fi &&
    if [ ! -e .models-ready-v2 ]; then
      ./env.sh python prepare.py && touch .models-ready-v2; fi &&
    ./run.sh start"
  open_tunnel
  printf 'waiting for the models to load'
  local deadline=$((SECONDS + 300)) p
  for p in "${PORTS[@]}"; do
    until healthy "$p"; do
      if [ "$SECONDS" -ge "$deadline" ]; then
        echo; echo "port $p is not healthy after 5 min; see '$0 logs'" >&2; exit 1
      fi
      if ! remote "cd ~/$REMOTE_DIR && ./run.sh status" | grep -q "$( [ "$p" = 8401 ] && echo stt || echo tts): running"; then
        echo; echo "the server for port $p exited; its log:" >&2
        remote "cd ~/$REMOTE_DIR && ./run.sh logs $( [ "$p" = 8401 ] && echo stt || echo tts) 30" >&2; exit 1
      fi
      printf .; sleep 2
    done
  done
  echo
  echo "STT: http://127.0.0.1:8401  (POST /v1/audio/transcriptions)"
  echo "TTS: http://127.0.0.1:8402  (POST /v1/audio/speech, s16le mono 24 kHz)"
}

status() {
  local st
  st=$(gpu status || true)  # exits 1 when no browser tunnel is open
  echo "$st" | grep -E '^(km-pc|gpu|local user):'
  grep -q 'up (NixOS)' <<<"$st" && remote "cd ~/$REMOTE_DIR 2>/dev/null && ./run.sh status" || true
  if tunnel_open; then echo "tunnel: open"; else echo "tunnel: closed"; fi
  for p in "${PORTS[@]}"; do
    if healthy "$p"; then echo "http://127.0.0.1:$p: healthy"; else echo "http://127.0.0.1:$p: not answering"; fi
  done
}

down() {
  if (gpu status || true) | grep -q 'up (NixOS)'; then
    remote "cd ~/$REMOTE_DIR 2>/dev/null && ./run.sh stop" || true
  else
    echo "km-pc is not up; nothing running there"
  fi
  close_tunnel
  echo "tunnels closed. km-pc is still awake: 'gpu sleep' when nothing else needs it"
}

case "${1:-}" in
  up) up "${2:-}" ;;
  status) status ;;
  down) down ;;
  restart) down; up "${2:-}" ;;
  logs) remote "cd ~/$REMOTE_DIR && ./run.sh logs ${2:-stt} ${3:-40}" ;;
  *) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
