#!/bin/bash
# Tier 574 — the scan preview asks whether the supplier is known; it creates none
#
# POST /ocr/match-supplier was "find or create", and the expenses page called
# it the moment a scan was picked: a preview that was then cancelled left a
# supplier behind (named after the OCR's first line), and a name corrected in
# the preview did not reach it. With `lookupOnly` the route only answers; the
# page creates the supplier together with the expense (Playwright
# ocr-scan-keeps-file-tier574 covers the page, and that the scan is attached).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-345-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
REG="{\"email\":\"$TAG@example.test\",\"password\":\"Tier574-e2e\",\"companyName\":\"$TAG GmbH\"}"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$REG" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
D=$(mktemp -d)
match() { curl -s -o "$D/out" -w '%{http_code}' -X POST "$API/api/v1/ocr/match-supplier?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" -d "$1"; }
out() { python3 -c "import sys,json;d=json.load(open(sys.argv[1]));print(eval(sys.argv[2]))" "$D/out" "$1" 2>/dev/null; }
N() { q "select count(*) from \"Supplier\" where \"companyId\"='$C'"; }

B='{"vatId":"DE123456789","name":"Musterfirma GmbH","lookupOnly":true}'
assert_eq "lookupOnly for an unknown supplier: answered, nothing found" "$(match "$B")/$(out "d['supplierId'], d['created'], d['matchedBy']")" "201/(None, False, None)"
assert_eq "…and no supplier was created" "$(N)" "0"
B='{"vatId":"DE123456789","name":"Musterfirma GmbH"}'
assert_eq "without lookupOnly (the confirmation): created" "$(match "$B")/$(out "d['created'], d['matchedBy']")" "201/(True, 'created')"
SUP=$(out "d['supplierId']")
B='{"vatId":"DE123456789","name":"ganz anders","lookupOnly":true}'
assert_eq "lookupOnly finds it by VAT ID" "$(match "$B")/$(out "d['supplierId'] == '$SUP', d['matchedBy']")" "201/(True, 'vatId')"
B='{"name":"musterfirma gmbh","lookupOnly":true}'
assert_eq "…and by name" "$(match "$B")/$(out "d['supplierId'] == '$SUP', d['matchedBy']")" "201/(True, 'name')"
B='{"lookupOnly":"true","name":"Noch Eine GmbH"}'
assert_eq "lookupOnly sent as the text \"true\" is still only a question" "$(match "$B")/$(out "d['supplierId']")/$(N)" "201/None/1"
assert_eq "one supplier in the end" "$(N)" "1"
rm -rf "$D"
summary
