#!/bin/bash
# Tier 904 — a scanned or imported USt-IdNr. is the one on file
#
# Measured: a supplier on file with DE123456789; the scan read
# "DE 123 456 789" — POST /ocr/match-supplier did not find it (it compared
# the text as read) and created a second supplier with the spaced number.
# A misread "DE12345" was stored as it was; so was "DE 999" from the expense
# CSV import. Both now go the way the suppliers page goes (Tier 490):
# normalised, and a number that is no valid EU format is not stored.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-592-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier904-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
field() { python3 -c "import json,sys;print(json.loads(sys.argv[1]).get(sys.argv[2]))" "$BODY" "$1"; }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc "$1"; }
TODAY=$(TZ=Europe/Berlin date +%F)
Q="companyId=$C"
AS POST "/api/v1/suppliers?$Q" '{"name":"Papier Müller GmbH","vatId":"DE123456789"}'
S=$(field id)
match() { AS POST "/api/v1/ocr/match-supplier?$Q" "$1"; }

match '{"vatId":"DE 123 456 789","name":"Papier Mueller"}'
assert_eq "the scan's „DE 123 456 789“ finds the supplier on file (was: a second one created)" "$(field supplierId)/$(field matchedBy)" "$S/vatId"
match '{"vatId":"de123456789","name":"Papier Mueller"}'
assert_eq "…and „de123456789“" "$(field supplierId)/$(field matchedBy)" "$S/vatId"
match '{"vatId":"DE12345","name":"Druck Schmidt"}'
NEW=$(field supplierId)
assert_eq "a misread „DE12345“: the supplier is created without it (was: stored as read)" "$(field created)/$(q "select coalesce(\"vatId\",'-') from \"Supplier\" where id='$NEW'")" "True/-"
match '{"vatId":"ATU 12345678","name":"Wien Papier"}'
AT=$(field supplierId)
assert_eq "a new supplier's valid number is stored normalised" "$(q "select \"vatId\" from \"Supplier\" where id='$AT'")" "ATU12345678"

ROWS="[{\"description\":\"CSV 592\",\"invoiceDate\":\"$TODAY\",\"supplierName\":\"Toner Lang\",\"supplierVatId\":\"DE 999\",\"invoiceNumber\":\"T-592\",\"netAmount\":\"100\",\"vatRate\":\"0.19\",\"vatAmount\":\"19\"},{\"description\":\"CSV 592 b\",\"invoiceDate\":\"$TODAY\",\"supplierName\":\"Kopie Kurz\",\"supplierVatId\":\"de 987 654 321\",\"invoiceNumber\":\"K-592\",\"netAmount\":\"50\",\"vatRate\":\"0.19\",\"vatAmount\":\"9.5\"}]"
AS POST "/api/v1/expenses/import?$Q" "{\"rows\":$ROWS}"
assert_eq "CSV: the row with „DE 999“ reported, not imported (was: a supplier with „DE 999“)" \
  "$(python3 -c "import json,sys;d=json.loads(sys.argv[1]);print(d['imported'], [(e['row'], 'Format' in e['error']) for e in d['errors']])" "$BODY")" \
  "1 [(2, True)]"
assert_eq "…the other row's supplier carries DE987654321; no „Toner Lang“" \
  "$(q "select string_agg(name||'='||coalesce(\"vatId\",'-'), ',' order by name) from \"Supplier\" where \"companyId\"='$C' and name in ('Kopie Kurz','Toner Lang')")" \
  "Kopie Kurz=DE987654321"
assert_eq "four suppliers in all — none twice" "$(q "select count(*) from \"Supplier\" where \"companyId\"='$C'")" "4"

summary
