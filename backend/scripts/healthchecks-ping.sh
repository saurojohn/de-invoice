#!/bin/bash
# scripts/healthchecks-ping.sh — active health monitoring via healthchecks.io
#
# Why this exists:
#   Tier 12 added /health and /health/deep
#   endpoints. They return 200 if the backend
#   is up and can reach the DB + storage.
#   But health endpoints only fire when
#   something polls them. Without an active
#   pinger, you only find out the backend is
#   down when a user complains.
#
#   healthchecks.io (https://healthchecks.io)
#   is a free hosted cron + dead-man-switch
#   service. This script pings it on a regular
#   interval. If the script doesn't ping for
#   N minutes, healthchecks.io sends an alert
#   email/SMS/Slack.
#
# Setup:
#   1. Sign up at https://healthchecks.io
#   2. Create a new check:
#        Name: "de-invoice-backend"
#        Period: 5 minutes
#        Grace: 5 minutes
#   3. Copy the "ping URL" — looks like
#        https://hc-ping.com/UUID-HERE
#   4. Save it to /etc/de-invoice/healthchecks.env:
#        HEALTHCHECKS_PING_URL=https://hc-ping.com/UUID-HERE
#        BACKEND_URL=http://localhost:3001
#      (chmod 600 so only root can read it)
#   5. Enable the systemd timer:
#        sudo cp infra/systemd/de-invoice-healthchecks.{service,timer} /etc/systemd/system/
#        sudo systemctl daemon-reload
#        sudo systemctl enable --now de-invoice-healthchecks.timer
#
# What it does:
#   1. Calls /health/deep on the backend.
#   2. If 200: pings healthchecks.io with /success.
#   3. If not 200 (or unreachable): pings /fail.
#   4. Logs everything to /var/log/de-invoice-healthchecks.log
#      (configurable via LOG_FILE env var).
#
# Failure modes we handle:
#   - Backend is down: curl returns non-zero, ping /fail.
#   - Backend is up but DB is down: /health/deep returns
#     503, ping /fail. (Tier 11 — /health/deep does the
#     DB ping itself.)
#   - Backend is up, DB is up, but storage is broken:
#     /health/deep returns 503, ping /fail.
#   - Backend is up, DB is up, storage is up: 200, ping /success.
#   - The script itself is broken (bad config): we exit
#     non-zero WITHOUT pinging anything. The systemd
#     timer doesn't depend on the script exit code —
#     it just runs the script every 5 minutes regardless.

set -uo pipefail

# Load config from a file outside the repo. This way the
# UUID doesn't get committed. If the file doesn't exist
# or is unreadable, we fail closed (no ping, exit 1) so
# the operator notices the misconfiguration.
CONFIG_FILE="${HEALTHCHECKS_CONFIG:-/etc/de-invoice/healthchecks.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

PING_URL="${HEALTHCHECKS_PING_URL:-}"
BACKEND_URL="${BACKEND_URL:-http://localhost:3001}"
LOG_FILE="${LOG_FILE:-/var/log/de-invoice-healthchecks.log}"

if [[ -z "$PING_URL" ]]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ERROR: HEALTHCHECKS_PING_URL not set. Create $CONFIG_FILE with the ping URL from https://healthchecks.io" | tee -a "$LOG_FILE" >&2
  exit 1
fi

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG_FILE"; }

# Probe /health/deep. We use --max-time so a hung
# backend doesn't block the script (which would
# silently miss the next ping interval).
HTTP_CODE=$(curl -sS -o /dev/null -w '%{http_code}' \
  --max-time 10 \
  "$BACKEND_URL/api/v1/health/deep" 2>/dev/null) || HTTP_CODE="000"

if [[ "$HTTP_CODE" == "200" ]]; then
  # /health/deep is 200 → backend + DB + storage all OK.
  # Ping /success so healthchecks.io records a heartbeat.
  curl -sS --max-time 5 -o /dev/null "$PING_URL" || true
  log "OK: /health/deep returned 200"
  exit 0
fi

# Anything else: /health/deep returned 503 (DB or
# storage broken) or the backend is unreachable.
# Ping /fail so healthchecks.io marks the check as
# down and (after the grace period) sends an alert.
FAIL_URL="${PING_URL}/fail"
curl -sS --max-time 5 -o /dev/null "$FAIL_URL" || true
log "FAIL: /health/deep returned $HTTP_CODE (expected 200)"
exit 0  # exit 0 so the timer doesn't accumulate failure state
