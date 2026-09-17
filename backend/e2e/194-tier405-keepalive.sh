#!/bin/bash
# Tier 405 — the backend must outlast every client that pools connections to it
#
# CI run 35157628517 had one flaky Playwright test, gobd-month-button-tier183 #4,
# failing with `read ECONNRESET` on a request that had nothing wrong with it and
# passing on retry. The cause is a race, not the test: Node's http server closes
# an idle keep-alive socket after 5 s (measured with scripts/probe-keepalive.ts:
# closed 6004 ms after its response), while a client that pools sockets can
# reuse one at the moment the server closes it.
#
# In production that client is nginx — `keepalive 32` with the default 60 s
# keepalive_timeout (infra/prod/nginx.conf) — and the symptom is an
# intermittent 502 "upstream prematurely closed connection" for a real user.
# The backend now keeps idle sockets for 65 s, and headersTimeout above that.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
BACKEND_DIR="$SCRIPT_DIR/.."
HOST_PORT="${API#http://}"; HOST="${HOST_PORT%%:*}"; PORT="${HOST_PORT##*:}"
[[ "$HOST" == "localhost" ]] && HOST=127.0.0.1

note "=== 1. an idle keep-alive socket survives well past Node's 5 s default ==="
# 10 s is long enough to be unambiguous (the old server closed at ~6 s) and
# short enough for the suite. The 65 s value itself is pinned statically below.
PROBE=$(cd "$BACKEND_DIR" && npx ts-node scripts/probe-keepalive.ts "$HOST" "$PORT" 10 2>&1 | tail -1)
note "probe: $PROBE"
[[ "$PROBE" == still-open-after-ms=* ]] && pass "the socket is still open after 10 s (was closed at ~6 s)" \
  || fail "the server closed the idle socket: $PROBE"

note "=== 2. the pairing with nginx is explicit and in the right order ==="
MAIN="$BACKEND_DIR/src/main.ts"
NGINX="$BACKEND_DIR/../infra/prod/nginx.conf"
BACKEND_MS=$(grep -oE "HTTP_KEEPALIVE_TIMEOUT_MS\) \|\| [0-9_]+" "$MAIN" | grep -oE "[0-9_]+$" | tr -d _)
[[ -n "$BACKEND_MS" ]] && pass "backend keepAliveTimeout default: ${BACKEND_MS} ms" || fail "no keepAliveTimeout default in main.ts"
grep -q "server.headersTimeout = keepAliveMs + " "$MAIN" \
  && pass "headersTimeout is set above keepAliveTimeout" || fail "headersTimeout not derived from keepAliveTimeout"
# Only the backend upstream matters here; read its block.
NGINX_S=$(awk '/upstream de_invoice_backend/,/}/' "$NGINX" | grep -oE "keepalive_timeout +[0-9]+s" | grep -oE "[0-9]+")
[[ -n "$NGINX_S" ]] && pass "nginx backend upstream keepalive_timeout: ${NGINX_S} s" \
  || fail "nginx backend upstream has no explicit keepalive_timeout"
if [[ -n "$BACKEND_MS" && -n "$NGINX_S" ]] && (( BACKEND_MS > NGINX_S * 1000 )); then
  pass "the backend outlasts nginx (${BACKEND_MS} ms > ${NGINX_S} s)"
else
  fail "the backend must keep sockets longer than nginx (${BACKEND_MS:-?} ms vs ${NGINX_S:-?} s)"
fi

summary; exit $?
