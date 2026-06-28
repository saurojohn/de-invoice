#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# de-invoice — Cloudflare real-IP nginx test (Tier 19)
#
# Spins up an nginx container with cloudflare-real-ip.conf
# loaded (plus a TEST-ONLY extra `set_real_ip_from 0.0.0.0/0`
# to simulate CF ingress without needing an actual CF IP
# as the TCP source). Verifies:
#   1. CF-Connecting-IP header is honored as the real IP
#      (overrides X-Forwarded-For)
#   2. X-Forwarded-For alone CANNOT spoof the IP — only
#      CF-Connecting-IP wins, X-Forwarded-For is ignored
#   3. Direct connections (no CF headers) show the TCP socket IP
#      (not the CF-Connecting-IP value if absent)
#
# Runs in ~10s. Self-contained: needs only Docker + curl.
# Does NOT depend on the dev backend being up.
# ─────────────────────────────────────────────────────────────────

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CF_CONF="$SCRIPT_DIR/cloudflare-real-ip.conf"

if [[ ! -f "$CF_CONF" ]]; then
  echo "ERROR: $CF_CONF not found" >&2
  exit 1
fi

# ─── Build the test nginx.conf (full file, replaces nginx.conf) ─
TEST_DIR="$(mktemp -d)"
cp "$CF_CONF" "$TEST_DIR/cloudflare-real-ip.conf"

# The TEST-ONLY augmentation: in production, nginx only
# honors CF-Connecting-IP for connections from CF IP ranges.
# But for testing, we can't easily fake "I came from a CF IP"
# from the curl client. So we add `set_real_ip_from 0.0.0.0/0;`
# at the BOTTOM of the include — this is appended after the
# production `set_real_ip_from` rules and acts as a catch-all
# for tests.
cat >> "$TEST_DIR/cloudflare-real-ip.conf" <<'TESTONLY'

# ─── TEST-ONLY (Tier 19) ──────────────────────────────────
# This catch-all is appended by test-real-ip.sh to simulate
# "connection comes from a CF IP". In production this line
# would mean "trust X-Forwarded-For from anywhere" — a
# security hole. Remove it before deploying.
set_real_ip_from 0.0.0.0/0;
TESTONLY

cat > "$TEST_DIR/nginx.conf" <<'NGINX'
worker_processes 1;
events { worker_connections 1024; }

http {
  access_log off;

  include /etc/nginx/test/cloudflare-real-ip.conf;

  server {
    listen 80;
    server_name _;

    # Echo the perceived client IP + inbound headers so we
    # can verify what nginx actually saw after the real_ip
    # restore.
    location = /whoami {
      default_type text/plain;
      return 200 "remote_addr=$remote_addr\ncf_connecting_ip=$http_cf_connecting_ip\nx_forwarded_for=$http_x_forwarded_for\nx_real_ip=$http_x_real_ip\n";
    }
  }
}
NGINX

# ─── Run nginx in a container ─────────────────────────────
CONTAINER_NAME="de-invoice-cf-test-$$"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  mavis-trash "$TEST_DIR" >/dev/null 2>&1 || rm -rf "$TEST_DIR"
}
trap cleanup EXIT

echo "Starting nginx test container..."
docker run -d \
  --name "$CONTAINER_NAME" \
  -p 18080:80 \
  -v "$TEST_DIR/nginx.conf:/etc/nginx/nginx.conf:ro" \
  -v "$TEST_DIR/cloudflare-real-ip.conf:/etc/nginx/test/cloudflare-real-ip.conf:ro" \
  nginx:1.27-alpine >/dev/null

# Wait for nginx to be ready (max 10s)
READY=false
for i in {1..20}; do
  if curl -s -m 1 http://localhost:18080/whoami >/dev/null 2>&1; then
    READY=true
    break
  fi
  sleep 0.5
done

if [[ "$READY" != true ]]; then
  echo "ERROR: nginx container failed to start" >&2
  docker logs "$CONTAINER_NAME" | tail -20
  exit 1
fi

# ─── Run test cases ───────────────────────────────────────
PASS=0
FAIL=0

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    echo "  [PASS] $label  (found: $needle)"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] $label  (expected to contain: $needle)"
    echo "        got: $haystack"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    echo "  [FAIL] $label  (should NOT contain: $needle)"
    echo "        got: $haystack"
    FAIL=$((FAIL + 1))
  else
    echo "  [PASS] $label  (correctly absent: $needle)"
    PASS=$((PASS + 1))
  fi
}

echo ""
echo "=== Test A — CF-Connecting-IP overrides X-Forwarded-For ==="
RESP=$(curl -s -m 3 \
  -H "CF-Connecting-IP: 203.0.113.42" \
  -H "X-Forwarded-For: 9.9.9.9" \
  http://localhost:18080/whoami)
echo "$RESP"
assert_contains "Test A.1 remote_addr = CF-Connecting-IP" "remote_addr=203.0.113.42" "$RESP"
assert_not_contains "Test A.2 X-Forwarded-For spoof rejected" "remote_addr=9.9.9.9" "$RESP"

echo ""
echo "=== Test B — X-Forwarded-For alone (no CF header) ==="
# Without CF-Connecting-IP, the real_ip directive can't
# determine the visitor IP (real_ip_header looks at
# CF-Connecting-IP only). The poisoned X-Forwarded-For is
# NOT trusted by nginx at all (nginx never reads
# X-Forwarded-For for $remote_addr — only the configured
# real_ip_header).
RESP=$(curl -s -m 3 \
  -H "X-Forwarded-For: 9.9.9.9" \
  http://localhost:18080/whoami)
echo "$RESP"
assert_not_contains "Test B.1 spoofed X-Forwarded-For ignored" "remote_addr=9.9.9.9" "$RESP"
# The remote_addr should be the docker bridge IP (we
# accepted anything that looks like a private IP). With
# the catch-all set_real_ip_from 0.0.0.0/0, no header
# value is set, so nginx falls back to... actually with
# the catch-all AND a missing real_ip_header source,
# nginx uses the socket IP, which is the docker bridge
# gateway (typically 172.17.0.1 or 192.168.65.1).
if echo "$RESP" | grep -qE "remote_addr=(127\.0\.0\.1|::1|172\.|10\.|192\.168\.)"; then
  echo "  [PASS] Test B.2 remote_addr is a private/loopback IP (no spoof)"
  PASS=$((PASS + 1))
else
  echo "  [FAIL] Test B.2 unexpected remote_addr"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Test C — direct connection (no headers at all) ==="
RESP=$(curl -s -m 3 http://localhost:18080/whoami)
echo "$RESP"
assert_not_contains "Test C.1 no headers → no spoof" "remote_addr=9.9.9.9" "$RESP"
assert_not_contains "Test C.2 no headers → no CF IP" "remote_addr=203.0.113.42" "$RESP"

echo ""
echo "=== Test D — alternate CF-Connecting-IP + extra CF headers ==="
RESP=$(curl -s -m 3 \
  -H "CF-Connecting-IP: 198.51.100.7" \
  -H "CF-IPCountry: DE" \
  -H "X-Forwarded-For: 8.8.8.8" \
  http://localhost:18080/whoami)
echo "$RESP"
assert_contains "Test D.1 alternate CF-Connecting-IP honored" "remote_addr=198.51.100.7" "$RESP"
assert_not_contains "Test D.2 X-Forwarded-For spoof still rejected" "remote_addr=8.8.8.8" "$RESP"

echo ""
echo "=== Test E — IPv6 CF-Connecting-IP (sanity) ==="
RESP=$(curl -s -m 3 --resolve notused:80:127.0.0.1 \
  -H "CF-Connecting-IP: 2001:db8::1" \
  http://localhost:18080/whoami)
echo "$RESP"
# real_ip_recursive takes the IPv6 if explicitly set
if echo "$RESP" | grep -qF "remote_addr=2001:db8::1"; then
  echo "  [PASS] Test E.1 IPv6 CF-Connecting-IP works"
  PASS=$((PASS + 1))
else
  echo "  [FAIL] Test E.1 IPv6 CF-Connecting-IP not honored"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "==============================="
echo "PASS: $PASS    FAIL: $FAIL"
echo "==============================="

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
echo "All Cloudflare real-IP nginx tests PASSED ✓"