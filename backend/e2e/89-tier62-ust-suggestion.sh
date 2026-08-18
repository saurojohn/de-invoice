#!/usr/bin/env bash
# e2e 89: Tier 62 — USt-Behandlung auto-detection.
#
# Validates the suggestion endpoint covers the four real-
# world B2B cases a German Mittelstand typically sees:
#   1. Customer in DE with DE VAT ID (Inland B2B) → standard
#   2. Customer in DE without VAT ID (B2C) → standard
#   3. Customer in EU (FR) with FR VAT ID, different country
#      (B2B EU goods / services) → euTransaction
#   4. Customer in non-EU (US) without VAT ID (Ausfuhr)
#      → standard
# Plus a few edge cases:
#   5. Customer with German full name "Deutschland" (alias
#      normalisation)
#   6. customerHasVatId + isEuB2b flags
#   7. 400 (BadRequestException) when companyId is missing
#   8. 400 (BadRequestException) when customerId is missing
#   9. Country name in English (e.g. "France") is normalised

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
# ───── 0. Wipe prior tier-62 fixtures ─────
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "Customer" WHERE "companyId" = '$COMPANY_ID'
  AND name LIKE 'Tier62-%';
SQL
pass "wiped prior tier-62 fixtures"

# Helper: create a test customer with the given fields
mk_customer() {
  local name="$1"
  local vatId="${2:-}"
  local country="$3"
  local body
  if [[ -n "$vatId" ]]; then
    body="{\"name\":\"$name\",\"vatId\":\"$vatId\",\"address\":{\"country\":\"$country\"}}"
  else
    body="{\"name\":\"$name\",\"address\":{\"country\":\"$country\"}}"
  fi
  curl -sS -X POST -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
    "$API/api/v1/customers?companyId=$COMPANY_ID" \
    -H "Content-Type: application/json" \
    -d "$body" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])"
}

# Helper: fetch the suggestion and return the JSON-encoded
# body via a temp file
get_suggestion() {
  local customerId="$1"
  local outf="$2"
  curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
    "$API/api/v1/invoices/ust-behandlung-suggestion?companyId=$COMPANY_ID&customerId=$customerId" \
    -o "$outf" -w "%{http_code}"
}

# Helper: extract a JSON field
jsf() {
  python3 -c "import json,sys; print(json.load(sys.stdin)['$1'])" < "$2"
}
jsf_str() {
  python3 -c "import json,sys; print(json.load(sys.stdin)['$1'])" < "$2"
}

# ───── 1. Inland B2B: DE customer with DE VAT ID → standard ─────
echo
note "=== 1. DE customer + DE VAT ID → standard (Inland B2B) ==="
C1=$(mk_customer "Tier62-Inland-B2B" "DE987654321" "DE")
TMP=$(mktemp)
STATUS=$(get_suggestion "$C1" "$TMP"); [[ "$STATUS" == "200" ]] && pass "200" || fail "expected 200, got $STATUS"
assert_eq "DE+DE VAT → standard" "$(jsf_str suggested "$TMP")" "standard"
assert_eq "DE+DE VAT → customerHasVatId=true" "$(jsf_str customerHasVatId "$TMP")" "True"
assert_eq "DE+DE VAT → isEuB2b=false" "$(jsf_str isEuB2b "$TMP")" "False"
rm -f "$TMP"

# ───── 2. B2C: DE customer without VAT ID → standard ─────
echo
note "=== 2. DE customer (no VAT) → standard (B2C) ==="
C2=$(mk_customer "Tier62-Inland-B2C" "" "DE")
TMP=$(mktemp)
STATUS=$(get_suggestion "$C2" "$TMP"); [[ "$STATUS" == "200" ]] && pass "200" || fail "expected 200, got $STATUS"
assert_eq "DE no-VAT → standard" "$(jsf_str suggested "$TMP")" "standard"
assert_eq "DE no-VAT → customerHasVatId=false" "$(jsf_str customerHasVatId "$TMP")" "False"
assert_eq "DE no-VAT → isEuB2b=false" "$(jsf_str isEuB2b "$TMP")" "False"
REASON=$(jsf_str reason "$TMP")
if echo "$REASON" | grep -q "B2C"; then
  pass "reason mentions B2C: $REASON"
else
  fail "reason missing B2C hint: $REASON"
fi
rm -f "$TMP"

# ───── 3. EU B2B: FR customer with FR VAT ID → euTransaction ─────
echo
note "=== 3. FR customer + FR VAT ID → euTransaction (EU B2B) ==="
C3=$(mk_customer "Tier62-EU-B2B" "FR12345678901" "FR")
TMP=$(mktemp)
STATUS=$(get_suggestion "$C3" "$TMP"); [[ "$STATUS" == "200" ]] && pass "200" || fail "expected 200, got $STATUS"
assert_eq "FR+FR VAT → euTransaction" "$(jsf_str suggested "$TMP")" "euTransaction"
assert_eq "FR+FR VAT → customerHasVatId=true" "$(jsf_str customerHasVatId "$TMP")" "True"
assert_eq "FR+FR VAT → isEuB2b=true" "$(jsf_str isEuB2b "$TMP")" "True"
REASON=$(jsf_str reason "$TMP")
if echo "$REASON" | grep -q "1a UStG\|13b UStG\|innergemeinschaftlich"; then
  pass "reason mentions §1a/§13b: $REASON"
else
  fail "reason missing §1a/§13b hint: $REASON"
fi
rm -f "$TMP"

# ───── 4. Ausfuhr: US customer without VAT ID → standard ─────
echo
note "=== 4. US customer (no VAT) → standard (Ausfuhr) ==="
C4=$(mk_customer "Tier62-Ausfuhr" "" "US")
TMP=$(mktemp)
STATUS=$(get_suggestion "$C4" "$TMP"); [[ "$STATUS" == "200" ]] && pass "200" || fail "expected 200, got $STATUS"
assert_eq "US no-VAT → standard" "$(jsf_str suggested "$TMP")" "standard"
assert_eq "US no-VAT → customerHasVatId=false" "$(jsf_str customerHasVatId "$TMP")" "False"
REASON=$(jsf_str reason "$TMP")
if echo "$REASON" | grep -q "Ausfuhrlieferung\|4 UStG\|Nicht-EU"; then
  pass "reason mentions Ausfuhr/§4 UStG: $REASON"
else
  fail "reason missing Ausfuhr/§4 UStG hint: $REASON"
fi
rm -f "$TMP"

# ───── 5. German country name "Deutschland" → DE ─────
echo
note "=== 5. country name alias 'Deutschland' → DE ==="
C5=$(mk_customer "Tier62-Deutschland" "" "Deutschland")
TMP=$(mktemp)
STATUS=$(get_suggestion "$C5" "$TMP"); [[ "$STATUS" == "200" ]] && pass "200" || fail "expected 200, got $STATUS"
assert_eq "Deutschland → standard" "$(jsf_str suggested "$TMP")" "standard"
rm -f "$TMP"

# ───── 6. English country name "France" → FR → euTransaction ─────
echo
note "=== 6. country name alias 'France' → FR ==="
C6=$(mk_customer "Tier62-France" "FR99999999999" "France")
TMP=$(mktemp)
STATUS=$(get_suggestion "$C6" "$TMP"); [[ "$STATUS" == "200" ]] && pass "200" || fail "expected 200, got $STATUS"
assert_eq "France+FR VAT → euTransaction" "$(jsf_str suggested "$TMP")" "euTransaction"
assert_eq "France+FR VAT → isEuB2b=true" "$(jsf_str isEuB2b "$TMP")" "True"
rm -f "$TMP"

# ───── 7. Bad request: missing companyId ─────
echo
note "=== 7. missing companyId → 400 ==="
TMP=$(mktemp)
STATUS=$(curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/invoices/ust-behandlung-suggestion?customerId=$C1" -o "$TMP" -w "%{http_code}")
assert_eq "missing companyId → 400" "$STATUS" "400"
rm -f "$TMP"

# ───── 8. Bad request: missing customerId ─────
echo
note "=== 8. missing customerId → 400 ==="
TMP=$(mktemp)
STATUS=$(curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/invoices/ust-behandlung-suggestion?companyId=$COMPANY_ID" -o "$TMP" -w "%{http_code}")
assert_eq "missing customerId → 400" "$STATUS" "400"
rm -f "$TMP"

# ───── 9. AT customer (Austrian VAT ID, same EU but diff country) ─────
echo
note "=== 9. AT customer with AT VAT ID → euTransaction (EU B2B) ==="
C9=$(mk_customer "Tier62-Austria" "ATU13585627" "AT")
TMP=$(mktemp)
STATUS=$(get_suggestion "$C9" "$TMP"); [[ "$STATUS" == "200" ]] && pass "200" || fail "expected 200, got $STATUS"
assert_eq "AT+AT VAT → euTransaction" "$(jsf_str suggested "$TMP")" "euTransaction"
rm -f "$TMP"

# ───── 10. Cleanup ─────
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "Customer" WHERE "companyId" = '$COMPANY_ID'
  AND name LIKE 'Tier62-%';
SQL
pass "cleanup complete"

summary
exit $?
