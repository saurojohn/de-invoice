#!/bin/bash
# Tier 604 — the Impressum shows the operator's own details
#
# /impressum had a made-up provider („Musterstraße 1, 12345 Musterstadt“,
# info@example.com, +49 (0) 000 000000) and a comment asking the operator to
# edit the source before going live. GET /companies/imprint — public — now
# returns what the operator (the oldest company) entered in its company
# settings, and nothing else of it; the page renders that, or says that it
# is missing.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
OUT=$(mktemp)
STATUS=$(curl -sS -o "$OUT" -w '%{http_code}' "$API/api/v1/companies/imprint")
py() { python3 -c "import sys,json;d=json.load(open(sys.argv[1]));$1" "$OUT" 2>/dev/null; }

note "=== 1. public, and only what an Impressum needs ==="
assert_eq "GET /companies/imprint without a session: 200" "$STATUS" "200"
assert_eq "the fields" "$(py 'print(",".join(sorted(d.keys())))')" "city,configured,country,email,managingDirector,name,phone,postalCode,registerEntry,street,vatId,website"
assert_eq "…no tax number, bank details, settings or ids" "$(grep -ciE 'taxId|iban|bankInfo|settings|"id"|createdAt' "$OUT")" "0"

note "=== 2. it is the operator: the oldest company ==="
OP=$(q "select id from \"Company\" order by \"createdAt\" asc limit 1")
assert_eq "the name is the operator's legal name, else its name" "$(py 'print(d["name"])')" "$(q "select coalesce(nullif(trim(\"legalName\"),''), nullif(trim(name),''), 'None') from \"Company\" where id='$OP'")"
assert_eq "the street is the operator's" "$(py 'print(d["street"])')" "$(q "select coalesce(nullif(trim(address->>'street'),''), 'None') from \"Company\" where id='$OP'")"
assert_eq "the VAT ID is the operator's" "$(py 'print(d["vatId"])')" "$(q "select coalesce(nullif(trim(\"vatId\"),''), 'None') from \"Company\" where id='$OP'")"
assert_eq "\"configured\" says whether name, street, city and e-mail are there" "$(py 'print(d["configured"] == bool(d["name"] and d["street"] and d["city"] and d["email"]))')" "True"

note "=== 3. another company's data never gets there ==="
TAG="e2e-360-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier604-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
curl -sS -o /dev/null -X PUT "$API/api/v1/companies/$C?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" \
  -d '{"legalName":"'$TAG' Geheim GmbH","email":"geheim-'$TAG'@example.test","address":{"street":"Geheimweg 9","city":"Berlin","postalCode":"10115","country":"DE"}}'
assert_eq "a newer company's details are not in the answer, with or without its session" \
  "$(curl -sS "$API/api/v1/companies/imprint" | grep -c "$TAG")/$(curl -sS -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/companies/imprint" | grep -c "$TAG")" "0/0"
assert_eq "…and /companies/<id> still wants a session" "$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/v1/companies/$C")" "401"

note "=== 4. the page has no made-up provider any more ==="
PAGE="$SCRIPT_DIR/../../frontend/src/app/impressum/page.tsx"
assert_eq "no placeholder address, phone or e-mail in the page's markup" "$(grep -vE '^\s*(\*|//|/\*)' "$PAGE" | grep -cE 'Musterstra|Musterstadt|example\.com|000 000000')" "0"
rm -f "$OUT"
summary
