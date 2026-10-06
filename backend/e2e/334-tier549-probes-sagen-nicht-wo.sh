#!/bin/bash
# Tier 549 — the probes that need no login say that it works, not where
#
# GET /api/v1/health/deep is public (the proxy forwards it for uptime
# monitors). Measured: checks.storage.detail was the storage directory's
# path on the server; when the database is down, checks.db.detail was the
# driver's message, which names host and port. Now: "writable" / an error
# code. GET /metrics stays open by default (Prometheus inside the compose
# network); with METRICS_TOKEN set it needs `Authorization: Bearer <token>`.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

D=$(curl -sS -m 20 "$API/api/v1/health/deep")
assert_eq "health/deep without login: storage ok" "$(json_field "$D" checks.storage.status)" "ok"
assert_eq "…it says writable (was the directory's path)" "$(json_field "$D" checks.storage.detail)" "writable"
assert_eq "…no path anywhere in the answer" "$(grep -c '"detail":"[^"]*/' <<<"$D")" "0"
assert_eq "…the database check still reports its time" "$(grep -c '"db":{"status":"ok","detail":"[0-9]*ms"' <<<"$D")" "1"
assert_eq "/metrics answers (no token configured in the suite)" "$(curl -s -o /dev/null -w '%{http_code}' -m 20 "$API/metrics")" "200"
summary
