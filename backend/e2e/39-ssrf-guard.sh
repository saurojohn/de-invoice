#!/bin/bash
# Tier 12: Security — SSRF guard on FinTS endpointUrl.
#
# The FinTS connection creation endpoint
# accepts an optional `endpointUrl`. We
# reject any value that:
#   - is not a valid URL
#   - is not HTTPS (would leak the PIN)
#   - points to a private / loopback /
#     link-local / .local / .internal IP
#     (catches SSRF attempts even if the
#     attacker has auth)
#
# Coverage:
#   1. Plain HTTP endpointUrl → 400
#   2. localhost endpointUrl → 400
#   3. 127.0.0.1 endpointUrl → 400
#   4. 10.x.x.x endpointUrl → 400
#   5. 192.168.x.x endpointUrl → 400
#   6. 172.16-31.x.x endpointUrl → 400
#   7. .local / .internal host → 400
#   8. malformed URL → 400
#   9. valid HTTPS to a public-looking host
#      is accepted (mock-mode so no real
#      call is made)
#   10. No endpointUrl at all is accepted
#       (the service resolves from BLZ)
#   11. Pre-existing connection is still
#       retrievable (didn't break the
#       non-validation path)

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

echo "=== Test: Tier 12 SSRF guard on FinTS endpointUrl ==="
# Clean leftover FinTSConnection
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice << EOF >/dev/null 2>&1
DELETE FROM "FinTsTransfer" WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM "FinTSSyncRun" WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM "FinTSConnection" WHERE "companyId" = '${COMPANY_ID}';
EOF

# ===== 1. Plain HTTP → 400 =====
api_post "/api/v1/fints/connections" '{
  "companyId":"'$COMPANY_ID'","blz":"50050201","userId":"test",
  "label":"T12-1","pin":"12345","mockMode":true,
  "endpointUrl":"http://bank.example.com/PinTanServlet"
}'
assert_eq "1. plain HTTP rejected" \
  "$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('statusCode',''))")" \
  "400"

# ===== 2. localhost → 400 =====
api_post "/api/v1/fints/connections" '{
  "companyId":"'$COMPANY_ID'","blz":"50050201","userId":"test",
  "label":"T12-2","pin":"12345","mockMode":true,
  "endpointUrl":"https://localhost:8443/PinTanServlet"
}'
assert_eq "2. localhost rejected" \
  "$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('statusCode',''))")" \
  "400"

# ===== 3. 127.0.0.1 → 400 =====
api_post "/api/v1/fints/connections" '{
  "companyId":"'$COMPANY_ID'","blz":"50050201","userId":"test",
  "label":"T12-3","pin":"12345","mockMode":true,
  "endpointUrl":"https://127.0.0.1:443/PinTanServlet"
}'
assert_eq "3. 127.0.0.1 rejected" \
  "$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('statusCode',''))")" \
  "400"

# ===== 4. 10.x.x.x → 400 =====
api_post "/api/v1/fints/connections" '{
  "companyId":"'$COMPANY_ID'","blz":"50050201","userId":"test",
  "label":"T12-4","pin":"12345","mockMode":true,
  "endpointUrl":"https://10.0.0.1/PinTanServlet"
}'
assert_eq "4. 10.x.x.x rejected" \
  "$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('statusCode',''))")" \
  "400"

# ===== 5. 192.168.x.x → 400 =====
api_post "/api/v1/fints/connections" '{
  "companyId":"'$COMPANY_ID'","blz":"50050201","userId":"test",
  "label":"T12-5","pin":"12345","mockMode":true,
  "endpointUrl":"https://192.168.1.1/PinTanServlet"
}'
assert_eq "5. 192.168.x.x rejected" \
  "$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('statusCode',''))")" \
  "400"

# ===== 6. 172.20.x.x → 400 =====
api_post "/api/v1/fints/connections" '{
  "companyId":"'$COMPANY_ID'","blz":"50050201","userId":"test",
  "label":"T12-6","pin":"12345","mockMode":true,
  "endpointUrl":"https://172.20.0.1/PinTanServlet"
}'
assert_eq "6. 172.20.x.x rejected" \
  "$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('statusCode',''))")" \
  "400"

# ===== 7. .internal host → 400 =====
api_post "/api/v1/fints/connections" '{
  "companyId":"'$COMPANY_ID'","blz":"50050201","userId":"test",
  "label":"T12-7","pin":"12345","mockMode":true,
  "endpointUrl":"https://bank.internal/PinTanServlet"
}'
assert_eq "7. .internal host rejected" \
  "$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('statusCode',''))")" \
  "400"

# ===== 8. malformed URL → 400 =====
api_post "/api/v1/fints/connections" '{
  "companyId":"'$COMPANY_ID'","blz":"50050201","userId":"test",
  "label":"T12-8","pin":"12345","mockMode":true,
  "endpointUrl":"not-a-url"
}'
assert_eq "8. malformed URL rejected" \
  "$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('statusCode',''))")" \
  "400"

# ===== 9. valid HTTPS public-looking host → 201 =====
api_post "/api/v1/fints/connections" '{
  "companyId":"'$COMPANY_ID'","blz":"50050201","userId":"test",
  "label":"T12-9","pin":"12345","mockMode":true,
  "endpointUrl":"https://banking.s-fints-1.de/PinTanServlet"
}'
HAS_ID=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if 'id' in d else 'no')")
assert_eq "9. valid HTTPS accepted" "$HAS_ID" "yes"

# ===== 10. No endpointUrl at all → 201 (BLZ resolves) =====
api_post "/api/v1/fints/connections" '{
  "companyId":"'$COMPANY_ID'","blz":"50050201","userId":"test",
  "label":"T12-10","pin":"12345","mockMode":true
}'
HAS_ID=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print('yes' if 'id' in d else 'no')")
assert_eq "10. no endpointUrl accepted" "$HAS_ID" "yes"

# ===== 11. Verify both stored connections are listable =====
api_get "/api/v1/fints/connections?companyId=$COMPANY_ID"
COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
assert_eq "11. both connections stored" "$COUNT" "2"

# ----- Cleanup -----
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice << EOF >/dev/null 2>&1
DELETE FROM "FinTsTransfer" WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM "FinTSSyncRun" WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM "FinTSConnection" WHERE "companyId" = '${COMPANY_ID}';
EOF
note "Cleanup done"

cleanup_cashbook
summary