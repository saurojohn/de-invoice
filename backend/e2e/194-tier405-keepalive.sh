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
# In production that client is the proxy, and the symptom is an intermittent
# 502 for a real user. The backend keeps idle sockets for 65 s, and
# headersTimeout above that.
#
# Tier 584: the proxy is Caddy. This spec compared the 65 s with the nginx
# file Caddy had replaced; Caddy's own default for idle upstream connections
# is 2 MINUTES — longer than the backend's 65 s, i.e. the race was back for
# every request Caddy cannot retry (a POST). Both Caddyfiles now say
# `keepalive 30s` for both upstreams, and the frontend keeps its sockets 65 s
# too (KEEP_ALIVE_TIMEOUT; Node's default is 5 s).
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

note "=== 2. the pairing with the proxy is explicit and in the right order ==="
MAIN="$BACKEND_DIR/src/main.ts"
PROD="$BACKEND_DIR/../infra/prod"
BACKEND_MS=$(grep -oE "HTTP_KEEPALIVE_TIMEOUT_MS\) \|\| [0-9_]+" "$MAIN" | grep -oE "[0-9_]+$" | tr -d _)
[[ -n "$BACKEND_MS" ]] && pass "backend keepAliveTimeout default: ${BACKEND_MS} ms" || fail "no keepAliveTimeout default in main.ts"
grep -q "server.headersTimeout = keepAliveMs + " "$MAIN" \
  && pass "headersTimeout is set above keepAliveTimeout" || fail "headersTimeout not derived from keepAliveTimeout"
FRONTEND_MS=$(grep -oE 'KEEP_ALIVE_TIMEOUT: "[0-9]+"' "$PROD/docker-compose.yml" | grep -oE "[0-9]+")
[[ -n "$FRONTEND_MS" ]] && pass "frontend KEEP_ALIVE_TIMEOUT in the compose file: ${FRONTEND_MS} ms (Node's default is 5000)" \
  || fail "the compose file sets no KEEP_ALIVE_TIMEOUT for the frontend"
# the idle time Caddy keeps a connection to an upstream, in seconds ("-" when
# the Caddyfile does not say — then it is Caddy's default, 2 minutes)
caddy_keepalive() { # file upstream
  python3 - "$1" "$2" <<'PY'
import re, sys
text = re.sub(r"#[^\n]*", "", open(sys.argv[1]).read())
out = []
for m in re.finditer(r"reverse_proxy\s+" + re.escape(sys.argv[2]) + r"\s*\{", text):
    depth, i = 1, m.end()
    while depth and i < len(text):
        depth += {"{": 1, "}": -1}.get(text[i], 0); i += 1
    k = re.search(r"\bkeepalive\s+(\d+)s\b", text[m.end():i])
    out.append(k.group(1) if k else "-")
print(" ".join(out) if out else "none")
PY
}
for f in Caddyfile Caddyfile.staging; do
  for pair in "backend:3001 ${BACKEND_MS:-0}" "frontend:3000 ${FRONTEND_MS:-0}"; do
    UP=${pair% *}; SERVER_MS=${pair#* }
    K=$(caddy_keepalive "$PROD/$f" "$UP")
    if [[ "$K" =~ ^[0-9]+$ ]] && (( K * 1000 < SERVER_MS )); then
      pass "$f: Caddy lets go of an idle connection to $UP after ${K} s — before the server does (${SERVER_MS} ms)"
    else
      fail "$f: $UP — Caddy's idle keep-alive is '${K}' (unset = 2 minutes), the server's ${SERVER_MS} ms; the proxy must let go first"
    fi
  done
done

summary; exit $?
