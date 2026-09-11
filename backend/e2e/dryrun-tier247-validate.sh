#!/bin/bash
# Tier 247 — Dryrun smoke validation
#
# NOT part of run-all.sh / CI: it targets the prod-image dryrun stack
# (API :3002, container de-invoice-dryrun-postgres). Tier 361 renamed it from
# 169-tier247-dryrun-validate.sh when run-all.sh started running three-digit
# specs; without a leading number the glob no longer picks it up. Run it by
# hand against a running dryrun stack.
#
# Validates that the prod Docker image serves the Tier 246
# signing endpoints correctly. Uses raw x-user-id / x-company-id
# headers (no JWT login) since the dryrun DB has a dummy
# password hash. Verifies:
#   1. /api/v1/health returns 200 with ok=true
#   2. /api/v1/signing/company-cert-info returns 200 with cert fields
#   3. /api/v1/signing/user-cert-info auto-creates a cert
#   4. GET again returns the same fingerprint (cached)
#   5. /api/v1/signing/user-regenerate rotates the cert
#   6. Cleanup: delete the seeded UserSigningKey row
set -uo pipefail

API="${API:-http://localhost:3002}"
USER_ID="${DRYRUN_USER_ID:-8c6a9669-0069-4137-a842-a66fd1d178d6}"
COMPANY_ID="${DRYRUN_COMPANY_ID:-ad257ec3-d319-479b-b870-3fe76e8f3111}"
export API USER_ID COMPANY_ID

source "$(dirname "$0")/_lib.sh"

H_AUTH=(-H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")

# ---- 1. /api/v1/health ----
H=$(curl -sS -o /tmp/tier247-health.json -w "%{http_code}" "$API/api/v1/health")
[ "$H" = "200" ] && pass "/api/v1/health → 200" || fail "expected 200, got $H"
STATUS=$(json_field "$(cat /tmp/tier247-health.json)" status)
[ "$STATUS" = "ok" ] && pass "health.status = ok" || fail "health.status = $STATUS"
VER=$(json_field "$(cat /tmp/tier247-health.json)" version)
[ -n "$VER" ] && pass "health.version = $VER" || fail "no version"

# ---- 2. company-cert-info (Tier 72 endpoint) ----
H=$(curl -sS -o /tmp/tier247-co.json -w "%{http_code}" \
  "$API/api/v1/signing/cert-info?companyId=$COMPANY_ID" "${H_AUTH[@]}")
[ "$H" = "200" ] && pass "GET /signing/cert-info → 200" || fail "expected 200, got $H: $(cat /tmp/tier247-co.json)"
CO_FP=$(json_field "$(cat /tmp/tier247-co.json)" fingerprint)
[ -n "$CO_FP" ] && pass "company cert has fingerprint: ${CO_FP:0:20}..." || fail "no company fingerprint"

# ---- 3. user-cert-info (Tier 246 endpoint) — first call auto-creates ----
H=$(curl -sS -o /tmp/tier247-user.json -w "%{http_code}" \
  "$API/api/v1/signing/user-cert-info?userId=$USER_ID" "${H_AUTH[@]}")
[ "$H" = "200" ] && pass "GET /signing/user-cert-info → 200" || fail "expected 200, got $H: $(cat /tmp/tier247-user.json)"
FP1=$(json_field "$(cat /tmp/tier247-user.json)" fingerprint)
CN=$(json_field "$(cat /tmp/tier247-user.json)" commonName)
VU=$(json_field "$(cat /tmp/tier247-user.json)" validUntil)
[ -n "$FP1" ] && pass "user cert has fingerprint: ${FP1:0:20}..." || fail "no fingerprint"
[ -n "$CN" ] && pass "commonName: $CN" || fail "no commonName"
[ -n "$VU" ] && pass "validUntil: $VU" || fail "no validUntil"

# Verify the row landed in the UserSigningKey table (in dryrun DB)
ROW_COUNT=$(docker exec de-invoice-dryrun-postgres psql -U deinvoice_dryrun -d deinvoice_dryrun -t -A -c "SELECT COUNT(*) FROM \"UserSigningKey\" WHERE \"userId\" = '$USER_ID';" 2>/dev/null)
[ "$ROW_COUNT" = "1" ] && pass "UserSigningKey row exists in dryrun DB" || fail "expected 1 row, got $ROW_COUNT"

# ---- 4. GET again — same fingerprint (cert cached) ----
curl -sS -o /tmp/tier247-user2.json "$API/api/v1/signing/user-cert-info?userId=$USER_ID" "${H_AUTH[@]}" >/dev/null
FP2=$(json_field "$(cat /tmp/tier247-user2.json)" fingerprint)
[ "$FP1" = "$FP2" ] && pass "second GET returns same fingerprint (cached)" || fail "fingerprint changed: $FP1 → $FP2"

# ---- 5. user-regenerate — fingerprint changes ----
H=$(curl -sS -o /tmp/tier247-regen.json -w "%{http_code}" -X POST \
  "$API/api/v1/signing/user-regenerate?userId=$USER_ID" "${H_AUTH[@]}")
[ "$H" = "201" ] || [ "$H" = "200" ] && pass "POST /signing/user-regenerate → $H" || fail "expected 200/201, got $H: $(cat /tmp/tier247-regen.json)"
FP3=$(json_field "$(cat /tmp/tier247-regen.json)" fingerprint)
[ -n "$FP3" ] && [ "$FP3" != "$FP1" ] && pass "fingerprint rotated: ${FP1:0:16}... → ${FP3:0:16}..." || fail "fingerprint did not rotate: $FP1 → $FP3"

# ---- 6. activity log written (Tier 207 pattern) ----
LOG_COUNT=$(docker exec de-invoice-dryrun-postgres psql -U deinvoice_dryrun -d deinvoice_dryrun -t -A -c "SELECT COUNT(*) FROM \"AuditLog\" WHERE action = 'signing.user_regenerate';" 2>/dev/null)
[ "$LOG_COUNT" -ge "1" ] 2>/dev/null && pass "signing.user_regenerate audit log written (count=$LOG_COUNT)" || fail "no audit log row (count=$LOG_COUNT)"

# ---- 7. /user-sign requires pdf in body (400 on missing) ----
H=$(curl -sS -o /tmp/tier247-sign-bad.json -w "%{http_code}" -X POST \
  "$API/api/v1/signing/user-sign" "${H_AUTH[@]}" \
  -H "Content-Type: application/json" -d "{\"userId\":\"$USER_ID\"}")
[ "$H" = "400" ] && pass "POST /user-sign without pdf → 400" || fail "expected 400, got $H: $(cat /tmp/tier247-sign-bad.json)"

# ---- 8. cleanup the seeded UserSigningKey row ----
docker exec de-invoice-dryrun-postgres psql -U deinvoice_dryrun -d deinvoice_dryrun -c "DELETE FROM \"UserSigningKey\" WHERE \"userId\" = '$USER_ID';" >/dev/null 2>&1
LEFT=$(docker exec de-invoice-dryrun-postgres psql -U deinvoice_dryrun -d deinvoice_dryrun -t -A -c "SELECT COUNT(*) FROM \"UserSigningKey\" WHERE \"userId\" = '$USER_ID';" 2>/dev/null)
[ "$LEFT" = "0" ] && pass "cleanup: deleted seeded UserSigningKey row" || fail "still $LEFT rows"

summary
