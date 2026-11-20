#!/bin/bash
# Tier 889 — an imported date is a day that exists
#
# Found after Tier 884 (looking at the import date readers): the expense
# import built a Date of „31.02.2026“ — JavaScript rolls it over to
# 03.03.2026, an expense (and its input VAT) in March's UStVA without a word.
# The Anlage SO import kept „2026-02-31“ (it allowed day 31 in every month).
# Both use isCalendarDay now (Tier 846), and the row is reported.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-580-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier889-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

note "=== 1. expenses ==="
read -r -d '' EXP <<'JSON'
{"rows":[
 {"description":"Miete Februar","invoiceDate":"31.02.2026","invoiceNumber":"M-580-1","supplierName":"Vermieter 580 GmbH","netAmount":"100","vatRate":"0.19"},
 {"description":"Miete Februar","invoiceDate":"28.02.2026","invoiceNumber":"M-580-2","supplierName":"Vermieter 580 GmbH","netAmount":"100","vatRate":"0.19"},
 {"description":"Miete April","invoiceDate":"2026-04-31","invoiceNumber":"M-580-3","supplierName":"Vermieter 580 GmbH","netAmount":"100","vatRate":"0.19"}
]}
JSON
AS POST "/api/v1/expenses/import?companyId=$C" "$EXP"
assert_eq "31.02. and 2026-04-31 reported, 28.02. imported" \
  "$(python3 -c "import json,sys;d=json.loads(sys.argv[1]);print(d['imported'], ' | '.join(e['error'] for e in d['errors']))" "$BODY")" \
  "1 Ungültiges Rechnungsdatum: 31.02.2026 | Ungültiges Rechnungsdatum: 2026-04-31"
assert_eq "no expense dated in March (was: 31.02. stored as 03.03.)" \
  "$(q "select string_agg(to_char(\"invoiceDate\",'YYYY-MM-DD'),',' order by \"invoiceDate\") from \"Expense\" where \"companyId\"='$C'")" "2026-02-28"

note "=== 2. Anlage SO ==="
CSV=$(printf 'type;description;acquisitionDate;acquisitionCost;saleDate;salePrice\nwertpapier;ACME;31.04.2026;100;15.05.2026;120\nwertpapier;BETA;30.04.2026;100;15.05.2026;120\n')
BODY=$(python3 -c "import json,sys;print(json.dumps({'companyId':sys.argv[1],'year':2026,'csv':sys.argv[2],'previewOnly':True}))" "$C" "$CSV")
R=$(curl -sS -X POST "$API/api/v1/accounting/anlage-so/import-csv?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" -d "$BODY")
assert_eq "31.04. marked, 30.04. read (was: „2026-04-31“ kept)" \
  "$(python3 -c "import json,sys;d=json.loads(sys.argv[1]);print(' | '.join('%s %s %s' % (r['transaction']['description'], r['ok'], r['transaction']['acquisitionDate']) for r in d['preview']))" "$R")" \
  "ACME False  | BETA True 2026-04-30"
summary
