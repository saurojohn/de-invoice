#!/bin/bash
# ───────────────────────────────────────────────
#  de-invoice shutdown
#  Stops the backend + frontend started by ./start.sh.
#  PostgreSQL is left running.
#
#  Tier 584: only processes started from THIS checkout are stopped. This
#  script used to `kill -9` whatever listened on :3001 and :3000 — on the
#  owner's computer :3001 is another project's server.
#
#  Usage:  ./stop.sh        (BACKEND_PORT / FRONTEND_PORT as for ./start.sh)
# ───────────────────────────────────────────────
cd "$(dirname "$0")"
ROOT="$(pwd -P)"
BACKEND_PORT="${BACKEND_PORT:-3001}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"

own() { # pid → is its working directory inside this checkout?
  local cwd
  cwd=$(lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
  case "$cwd" in "$ROOT"|"$ROOT"/*) return 0 ;; esac
  return 1
}

echo "Stopping de-invoice..."
PIDS=""
for pidfile in /tmp/backend.pid /tmp/next-dev.pid; do
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null && own "$pid"; then PIDS="$PIDS $pid"; fi
    rm -f "$pidfile"
  fi
done
for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  for pid in $(lsof -ti:"$port" -sTCP:LISTEN 2>/dev/null); do
    if own "$pid"; then PIDS="$PIDS $pid"
    else echo "Port $port is held by another program (pid $pid) — left alone."; fi
  done
done
if [ -n "$PIDS" ]; then
  kill $PIDS 2>/dev/null
  # TERM first: the backend stops its database engine with it. KILL only what is left.
  for i in 1 2 3 4 5; do
    LEFT=""; for pid in $PIDS; do kill -0 "$pid" 2>/dev/null && LEFT="$LEFT $pid"; done
    [ -z "$LEFT" ] && break; sleep 1
  done
  [ -n "$LEFT" ] && kill -9 $LEFT 2>/dev/null
  echo "Stopped:$PIDS"
else
  echo "Nothing of this checkout was running."
fi
echo "Done. (PostgreSQL left running.)"
