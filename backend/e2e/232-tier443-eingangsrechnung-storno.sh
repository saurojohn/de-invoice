#!/bin/bash
# Tier 443 — a booked supplier invoice is cancelled, not deleted
#
# Measured before: DELETE /ustva/expenses/:id removed any expense (200) —
#   - one whose input tax a submitted UStVA had declared (the period then
#     computed 0 € Vorsteuer against 19 € declared)
#   - one paid by SEPA, one paid through the cash book (the cash payment lost
#     its link and became a cash purchase of its own), an AfA row
# There was no Storno. And a month whose input tax was negative (a supplier
# credit note, Tier 442) could not be filed: the filing DTO had Min(0) on
# the input tax (400).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-232-$(date +%s%N | cut -c1-13)"
Y=2025

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier443-e2e\",\"companyName\":\"$TAG Handel\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
AS POST "/api/v1/suppliers?companyId=$C" '{"name":"'$TAG' Lieferant","address":{"street":"a","city":"b","postalCode":"1","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX"}}'
S=$(json_field "$BODY" id)
expense() { # number date → id
  AS POST "/api/v1/ustva/expenses?companyId=$C" '{"supplierId":"'$S'","invoiceNumber":"'$1'","description":"'$1'","invoiceDate":"'$2'","netAmount":100,"vatRate":0.19,"vatAmount":19,"grossAmount":119}'
  json_field "$BODY" id
}
file_month() { # month → status of the submitted filing
  AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y&month=$1"
  echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);d['status']='submitted';print(json.dumps(d))" > /tmp/t443-filing.json
  curl -sS -o /dev/null -w "%{http_code}" -X POST "$API/api/v1/ustva/filings?companyId=$C" \
    -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" -d @/tmp/t443-filing.json
}
vorsteuer() { AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y&month=$1"; py 'print(d["vorsteuerSum"])'; }
del() { AS DELETE "/api/v1/ustva/expenses/$1?companyId=$C"; echo "$STATUS"; }

FREE=$(expense ER-FREI $Y-05-10)
FILED=$(expense ER-JAN $Y-01-10)
SEPA=$(expense ER-SEPA $Y-04-10)
CASH=$(expense ER-BAR $Y-04-11)
assert_eq "January UStVA submitted" "$(file_month 1)" "201"
AS POST "/api/v1/payments/batches" '{"companyId":"'$C'","expenseIds":["'$SEPA'"],"executionDate":"'$Y'-04-12","debtorIban":"DE02120300000000202051","debtorName":"'$TAG'"}'
AS POST "/api/v1/cashbook/entries?companyId=$C" '{"businessDate":"'$Y'-04-11","type":"eroeffnung","description":"AB","amount":500}'
AS POST "/api/v1/cashbook/entries?companyId=$C" '{"businessDate":"'$Y'-04-11","type":"ausgabe","description":"bar","amount":119,"vatRate":0.19,"expenseId":"'$CASH'"}'
AS POST "/api/v1/assets?companyId=$C" '{"type":"Maschine","bezeichnung":"M","anschaffungsDatum":"'$Y'-01-10","anschaffungsKosten":6000,"nutzungsdauerMonate":60}'
AS POST "/api/v1/assets/book-afa?companyId=$C&year=$Y"
AFA=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "SELECT id FROM \"Expense\" WHERE \"companyId\"='$C' AND category='AfA'")

note "=== delete ==="
assert_eq "an unpaid expense of an open period can still be deleted" "$(del "$FREE")" "200"
AS DELETE "/api/v1/ustva/expenses/$FILED?companyId=$C"
assert_eq "declared in the submitted UStVA 2025-01: refused (was 200)" "$STATUS" "400"
echo "$BODY" | grep -q "UStVA 2025-01" && echo "$BODY" | grep -q "stornieren" \
  && pass "the message names the filing and says to cancel" || fail "message: $BODY"
assert_eq "paid by SEPA: refused (was 200)" "$(del "$SEPA")" "400"
assert_eq "paid through the cash book: refused (was 200)" "$(del "$CASH")" "400"
assert_eq "an AfA row: refused (was 200)" "$(del "$AFA")" "400"
assert_eq "the cash payment keeps its link" \
  "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "SELECT count(*) FROM \"CashBookEntry\" WHERE \"expenseId\"='$CASH'")" "1"

note "=== storno ==="
AS POST "/api/v1/ustva/expenses/$FILED/storno?companyId=$C" '{"reason":""}'
assert_eq "a reason is required" "$STATUS" "400"
AS POST "/api/v1/ustva/expenses/$FILED/storno?companyId=$C" '{"reason":"doppelt erfasst","date":"'$Y'-02-05"}'
assert_eq "cancelled by a counter-entry (was 404)" "$STATUS" "201"
assert_eq "negative, dated the storno day, linked" \
  "$(py 'print(d["grossAmount"], d["vatAmount"], d["invoiceDate"][:10], d["stornoOfId"])')" "-119 -19 $Y-02-05 $FILED"
ST=$(json_field "$BODY" id)
assert_eq "January stays as declared" "$(vorsteuer 1)" "19"
assert_eq "February carries the correction" "$(vorsteuer 2)" "-19"
assert_eq "February (negative input tax) can be filed (was 400)" "$(file_month 2)" "201"
AS POST "/api/v1/ustva/expenses/$FILED/storno?companyId=$C" '{"reason":"nochmal"}'
assert_eq "no second storno" "$STATUS" "400"
AS POST "/api/v1/ustva/expenses/$ST/storno?companyId=$C" '{"reason":"x"}'
assert_eq "a storno is not cancelled itself" "$STATUS" "400"
assert_eq "a storno cannot be deleted" "$(del "$ST")" "400"
AS POST "/api/v1/ustva/expenses/$AFA/storno?companyId=$C" '{"reason":"x"}'
assert_eq "AfA is cancelled in the asset register, not here" "$STATUS" "400"
AS POST "/api/v1/ustva/expenses/$SEPA/storno?companyId=$C" '{"reason":"Lieferung zurückgegeben","date":"'$Y'-04-20"}'
assert_eq "a paid expense can be cancelled" "$STATUS" "201"
AS POST "/api/v1/ustva/expenses?companyId=$C" '{"supplierId":"'$S'","invoiceNumber":"GS-JUN","description":"Gutschrift","invoiceDate":"'$Y'-06-10","netAmount":50,"vatRate":0.19,"vatAmount":9.5,"grossAmount":59.5,"creditNote":true}'
assert_eq "a June with only a supplier credit note (Vorsteuer -9.50) can be filed (was 400)" "$(file_month 6)" "201"
AS GET "/api/v1/ustva/expenses?companyId=$C&year=$Y"
assert_eq "the list marks what is cancelled" \
  "$(py 'print(sorted(e["invoiceNumber"] for e in d if e.get("stornoBy")))')" "['ER-JAN', 'ER-SEPA']"

summary
