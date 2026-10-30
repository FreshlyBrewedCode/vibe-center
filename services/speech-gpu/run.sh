#!/usr/bin/env bash
# On km-pc: start/stop the speech servers as detached processes that outlive the SSH
# session (the `gpu` user has no lingering systemd user manager, so no `systemd-run --user`;
# logind keeps processes of ended sessions since KillUserProcesses=false).
#   ./run.sh start | stop | status | logs [stt|tts]
set -uo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
cd "$DIR"
mkdir -p run logs
SERVERS=(stt tts)

pid_of() { local p; p=$(cat "run/$1.pid" 2>/dev/null) && kill -0 "$p" 2>/dev/null && echo "$p"; }

start() {
  local s=$1
  if pid_of "$s" >/dev/null; then echo "$s: already running (pid $(pid_of "$s"))"; return; fi
  # new session (setsid): no controlling terminal, and stop can kill the whole group.
  # $$ stays the server's pid: env.sh and `nix shell` exec into python.
  setsid bash -c 'echo $$ > "run/$0.pid"; exec ./env.sh python "${0}_server.py"' "$s" \
    >> "logs/$s.log" 2>&1 < /dev/null &
  sleep 0.2
  echo "$s: started (pid $(cat "run/$s.pid"), log ~/vibe-center/gpu-speech/logs/$s.log)"
}

stop() {
  local s=$1 p
  if ! p=$(pid_of "$s"); then echo "$s: not running"; rm -f "run/$s.pid"; return; fi
  kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p"
  for _ in $(seq 1 50); do kill -0 "$p" 2>/dev/null || break; sleep 0.1; done
  kill -0 "$p" 2>/dev/null && kill -KILL -- "-$p" 2>/dev/null
  rm -f "run/$s.pid"
  echo "$s: stopped"
}

case "${1:-status}" in
  start) for s in "${SERVERS[@]}"; do start "$s"; done ;;
  stop) for s in "${SERVERS[@]}"; do stop "$s"; done ;;
  status)
    for s in "${SERVERS[@]}"; do
      if p=$(pid_of "$s"); then
        # the server's whole session: the STT server runs its model in a child process
        pids=" $(ps -o pid= -s "$p" | tr -s ' \n' ' ') "
        mem=$(nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits |
              awk -F', ' -v ps="$pids" 'index(ps, " " $1 " ") { m += $2 } END { if (m) print m " MiB VRAM" }')
        echo "$s: running (pid $p${mem:+, $mem})"
      else echo "$s: not running"; fi
    done ;;
  logs) tail -n "${3:-40}" "logs/${2:-stt}.log" ;;
  *) echo "usage: run.sh start|stop|status|logs [stt|tts] [lines]" >&2; exit 2 ;;
esac
