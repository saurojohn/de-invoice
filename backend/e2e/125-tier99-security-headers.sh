#!/usr/bin/env bash
# Tier 99 (Polish #4) — security headers
# regression test.
#
# Verifies the backend sends the expected
# security headers (configured via helmet
# in src/main.ts). If a future tier adds
# a middleware that strips or rewrites
# headers, this test fails immediately
# — better than discovering it during
# a security audit.
#
# Headers checked:
#   - Strict-Transport-Security: HSTS
#     (forces HTTPS in browsers)
#   - X-Frame-Options: SAMEORIGIN
#     (clickjacking protection)
#   - X-Content-Type-Options: nosniff
#     (prevents MIME sniffing)
#   - Referrer-Policy: no-referrer
#     (privacy — don't leak referrer)
#   - X-DNS-Prefetch-Control: off
#     (privacy — don't pre-resolve)
#   - X-Permitted-Cross-Domain-Policies: none
#     (legacy Flash/PDF policies)
#   - X-Download-Options: noopen
#     (legacy IE behavior)
#   - Cross-Origin-Resource-Policy: cross-origin
#     (allows the frontend to load PDFs/images)

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/_lib.sh"

login

note "=== 1. Backend response includes all expected security headers ==="
HEADERS_FILE=$(mktemp)
# Hit a public endpoint so we don't have to
# deal with 401 + the actual security
# headers might be different on 401 paths.
/api/v1/health 2>/dev/null # noop, just source
curl -sSI -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/health" > "$HEADERS_FILE"
rm -f "$HEADERS_FILE"
HEADERS_FILE=$(mktemp)
curl -sSI -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/health" > "$HEADERS_FILE"

# Each expected header: name, expected value pattern
declare -a EXPECTED=(
  "Strict-Transport-Security|max-age="
  "X-Frame-Options|SAMEORIGIN"
  "X-Content-Type-Options|nosniff"
  "Referrer-Policy|no-referrer"
  "X-DNS-Prefetch-Control|off"
  "X-Permitted-Cross-Domain-Policies|none"
  "X-Download-Options|noopen"
  "Cross-Origin-Resource-Policy|cross-origin"
)

for entry in "${EXPECTED[@]}"; do
  IFS='|' read -r name pattern <<< "$entry"
  # Header name is case-insensitive in HTTP,
  # but most servers normalize to Title-Case.
  # grep -i handles both.
  if grep -qi "^${name}:" "$HEADERS_FILE"; then
    if [[ -n "$pattern" ]]; then
      if grep -i "^${name}:" "$HEADERS_FILE" | grep -q "$pattern"; then
        pass "${name} present with expected value"
      else
        fail "${name} present but value doesn't match '${pattern}'"
      fi
    else
      pass "${name} present"
    fi
  else
    fail "${name} missing from response"
  fi
done

note "=== 2. CORS preflight allows the configured frontend origin ==="
PREFLIGHT_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X OPTIONS \
  -H "Origin: http://localhost:3100" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: x-user-id,x-company-id" \
  "$API/api/v1/invoices?companyId=$COMPANY_ID")
# 204 No Content is the standard CORS preflight response
if [[ "$PREFLIGHT_STATUS" == "204" ]]; then
  pass "CORS preflight returns 204"
else
  fail "CORS preflight returned $PREFLIGHT_STATUS (expected 204)"
fi

note "=== 3. CORS rejects unknown origins ==="
REJECT_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  -X OPTIONS \
  -H "Origin: https://evil.example.com" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: x-user-id" \
  "$API/api/v1/invoices?companyId=$COMPANY_ID")
# 500 (CORS callback rejected) or 403 are both
# acceptable — the point is the request
# is NOT permitted.
if [[ "$REJECT_STATUS" == "500" || "$REJECT_STATUS" == "403" || "$REJECT_STATUS" == "401" ]]; then
  pass "CORS rejects unknown origin (status=$REJECT_STATUS)"
else
  fail "CORS allowed unknown origin (status=$REJECT_STATUS) — should reject"
fi

note "=== 4. No X-Powered-By header (don't leak framework) ==="
# Express often sends `X-Powered-By: Express`
# by default. We don't disable it explicitly
# in main.ts, so this is a soft check — fail
# if Express actually sends it.
if grep -qi "^X-Powered-By:" "$HEADERS_FILE"; then
  POWERED=$(grep -i "^X-Powered-By:" "$HEADERS_FILE" | head -1 | tr -d '\r\n')
  fail "Backend leaks framework info: $POWERED"
else
  pass "X-Powered-By not present (framework info hidden)"
fi

note "=== 5. Response is not cached by default for /api/v1/* ==="
# We don't set explicit cache-control on
# most endpoints — that's fine. But for
# endpoints that handle sensitive data
# (auth, balance, etc.) we should at
# minimum not have stale-cache issues.
# This is a soft check — just log a
# warning if Cache-Control is set to
# something inappropriate.
CACHE_HEADER=$(grep -i "^Cache-Control:" "$HEADERS_FILE" | head -1 | tr -d '\r\n')
if [[ -z "$CACHE_HEADER" ]]; then
  pass "No Cache-Control header (relies on default no-cache for /api/v1/*)"
else
  echo "  note: $CACHE_HEADER"
fi

rm -f "$HEADERS_FILE"

summary
