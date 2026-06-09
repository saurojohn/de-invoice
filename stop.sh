#!/bin/bash
# Stop the de-invoice dev stack.
# Kills the backend and frontend by their saved PIDs,
# then makes sure the ports are free.
echo "Stopping de-invoice..."

for pidfile in /tmp/backend.pid /tmp/next-dev.pid; do
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null
      echo "Killed $pidfile ($pid)"
    fi
    rm -f "$pidfile"
  fi
done

# Belt-and-suspenders: free the ports even if the
# pidfile approach missed a stray process.
lsof -ti:3001 2>/dev/null | xargs -r kill -9 2>/dev/null
lsof -ti:3000 2>/dev/null | xargs -r kill -9 2>/dev/null

# We do NOT stop PostgreSQL — it's typically
# wanted up between dev sessions. Stop it with
# `brew services stop postgresql@16` if you need.

echo "Done. (PostgreSQL left running — stop with: brew services stop postgresql@16)"
