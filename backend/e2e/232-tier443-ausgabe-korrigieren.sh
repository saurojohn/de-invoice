#!/bin/bash
# Tier 443 — an expense can be corrected while it is open, and a paid or
# booked one is not deleted behind the books' back
#
# Measured before:
#   - There was no way to correct an expense (Eingangsrechnung): no PUT on
#     /expenses or /ustva/expenses (404). A typo in the amount meant delete
#     and enter again.
#   - DELETE /ustva/expenses/:id checked nothing. An expense paid by a SEPA
#     batch was deleted (200): the money had left the bank, the SEPA batch
#     still listed the payment, and the cost, the input tax and the DATEV
#     payment row were gone. An AfA row of the asset register was deleted
#     one by one (200) past the AfA storno, so the asset register said
#     "AfA gebucht" for a year no report had AfA for. An expense paid from
#     the cash book was deleted too (200); its cash-book Ausgabe lost the
#     link (expenseId set to NULL) and stayed as an unexplained payment.
#
# Now: PUT /expenses/:id and PUT /ustva/expenses/:id change an open expense
# (amounts entered positive, a credit note keeps its sign). A paid expense
# (bank, SEPA, cash book) and an AfA row can be neither changed nor deleted
# — 400 with the way out: a supplier credit note (Tier 442), the SEPA storno
# (Tier 433), the cash-book storno, the AfA storno. Only its notes change.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-232-$(date +%s%N | cut -c1-13)"
Y=2025
TODAY=$(date +%F)

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
says() { grep -qF "$1" <<<"$BODY" && echo yes || echo "no: $BODY"; }

AS POST "/api/v1/suppliers?companyId=$C" '{"name":"'$TAG' Lieferant","address":{"street":"a","city":"b","postalCode":"1","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX"}}'
S=$(json_field "$BODY" id)
expense() { # number date net
  AS POST "/api/v1/ustva/expenses?companyId=$C" '{"supplierId":"'$S'","invoiceNumber":"'$1'","description":"'$1'","invoiceDate":"'$2'","netAmount":'$3',"vatRate":0.19,"vatAmount":'$(python3 -c "print(round($3*0.19,2))")',"grossAmount":'$(python3 -c "print(round($3*1.19,2))")'}'
  json_field "$BODY" id
}

note "=== an open expense can be corrected ==="
OPEN=$(expense ER-OFFEN $Y-03-01 1000)
AS PUT "/api/v1/ustva/expenses/$OPEN?companyId=$C" '{"netAmount":100,"vatRate":0.19}'
assert_eq "PUT /ustva/expenses/:id (was 404)" "$STATUS" "200"
assert_eq "net 100, VAT and gross derived" "$(py 'print(d["netAmount"], d["vatAmount"], d["grossAmount"])')" "100 19 119"
AS PUT "/api/v1/expenses/$OPEN?companyId=$C" '{"invoiceDate":"'$Y'-04-02","invoiceNumber":"ER-1","description":"Ware korrigiert","netAmount":200,"vatRate":0.07}'
assert_eq "PUT /expenses/:id (was 404)" "$STATUS" "200"
assert_eq "date, number, rate" "$(py 'print(d["invoiceDate"][:10], d["invoiceNumber"], d["vatRate"], d["vatAmount"], d["grossAmount"])')" \
  "$Y-04-02 ER-1 0.07 14 214"
AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y"
assert_eq "the UStVA follows: Vorsteuer 7 % only" "$(py 'print(round(d["vorsteuer"]["from19"],2), round(d["vorsteuer"]["from7"],2))')" "0 14"
AS PUT "/api/v1/expenses/$OPEN?companyId=$C" '{"netAmount":-5}'
assert_eq "a negative amount is refused (a credit note says so)" "$STATUS" "400"
AS PUT "/api/v1/expenses/$OPEN?companyId=$C" '{"paidBySepaBatchId":"x"}'
assert_eq "an unknown field is refused" "$STATUS" "400"

GS=$(AS POST "/api/v1/ustva/expenses?companyId=$C" '{"supplierId":"'$S'","invoiceNumber":"GS-1","description":"Gutschrift","invoiceDate":"'$Y'-05-01","netAmount":50,"vatRate":0.19,"vatAmount":9.5,"grossAmount":59.5,"creditNote":true}'; json_field "$BODY" id)
AS PUT "/api/v1/ustva/expenses/$GS?companyId=$C" '{"netAmount":40}'
assert_eq "a credit note stays a credit note" "$(py 'print(d["netAmount"], d["vatAmount"], d["grossAmount"])')" "-40 -7.6 -47.6"

note "=== another company's expense ==="
read -r U2 C2 < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG-b@example.test\",\"password\":\"Tier443-e2e\",\"companyName\":\"$TAG B\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
B=$(curl -sS -o /dev/null -w "%{http_code}" -X PUT "$API/api/v1/expenses/$OPEN?companyId=$C2" -H "x-user-id: $U2" -H "x-company-id: $C2" \
  -H "Content-Type: application/json" -d '{"netAmount":1}')
assert_eq "B cannot change A's expense" "$B" "404"
AS GET "/api/v1/expenses/$OPEN?companyId=$C"
assert_eq "A's expense unchanged" "$(py 'print(d["netAmount"])')" "200"

note "=== paid by SEPA: neither changed nor deleted ==="
SEPA=$(expense ER-SEPA $TODAY 100)
AS POST "/api/v1/payments/batches" '{"companyId":"'$C'","expenseIds":["'$SEPA'"],"executionDate":"'$TODAY'","debtorIban":"DE02120300000000202051","debtorName":"'$TAG' GmbH"}'
BATCH=$(json_field "$BODY" id)
AS DELETE "/api/v1/ustva/expenses/$SEPA?companyId=$C"
assert_eq "delete refused (was 200: paid, and gone from the books)" "$STATUS" "400"
assert_eq "the message names the SEPA storno" "$(says "SEPA")" "yes"
AS PUT "/api/v1/expenses/$SEPA?companyId=$C" '{"netAmount":90}'
assert_eq "amount change refused" "$STATUS" "400"
AS PUT "/api/v1/expenses/$SEPA?companyId=$C" '{"paidAt":null}'
assert_eq "…nor its payment date taken out (Tier 454: the storno does that)" "$STATUS" "400"
AS PUT "/api/v1/expenses/$SEPA?companyId=$C" '{"notes":"Skonto nachgefragt"}'
assert_eq "the notes can still change" "$(py 'print(d.get("notes"), d["netAmount"])')" "Skonto nachgefragt 100"
AS GET "/api/v1/expenses/$SEPA?companyId=$C"
assert_eq "the paid expense is still there" "$STATUS" "200"
AS POST "/api/v1/payments/batches/$BATCH/cancel?companyId=$C" '{"reason":"nicht ausgeführt"}'
AS PUT "/api/v1/expenses/$SEPA?companyId=$C" '{"netAmount":90}'
assert_eq "after the SEPA storno it is open again and can be corrected" "$(py 'print(d["netAmount"], d["grossAmount"])')" "90 107.1"

note "=== paid from the cash book ==="
BAR=$(expense ER-BAR $TODAY 100)
AS POST "/api/v1/cashbook/entries?companyId=$C" '{"businessDate":"'$TODAY'","type":"eroeffnung","description":"Anfangsbestand","amount":500}'
AS POST "/api/v1/cashbook/entries?companyId=$C" '{"businessDate":"'$TODAY'","type":"ausgabe","description":"Bar ER-BAR","amount":119,"vatRate":0.19,"expenseId":"'$BAR'"}'
AS DELETE "/api/v1/ustva/expenses/$BAR?companyId=$C"
assert_eq "delete refused (was 200, the cash-book entry lost its link)" "$STATUS" "400"
assert_eq "the message names the cash book" "$(says "Kassenbuch")" "yes"

note "=== an AfA row belongs to the asset register ==="
AS POST "/api/v1/assets?companyId=$C" '{"type":"Maschine","bezeichnung":"Maschine","anschaffungsDatum":"'$Y'-01-10","anschaffungsKosten":6000,"nutzungsdauerMonate":60}'
AS POST "/api/v1/assets/book-afa?companyId=$C&year=$Y"
AFA=$(AS GET "/api/v1/ustva/expenses?companyId=$C&year=$Y"; py 'print([e["id"] for e in d if e.get("relatedAssetId")][0])')
AS DELETE "/api/v1/ustva/expenses/$AFA?companyId=$C"
assert_eq "an AfA row is not deleted by hand (was 200)" "$STATUS" "400"
assert_eq "the message names the AfA storno" "$(says "AfA")" "yes"
AS PUT "/api/v1/expenses/$AFA?companyId=$C" '{"netAmount":1}'
assert_eq "nor changed" "$STATUS" "400"

note "=== the list says which ones are locked ==="
AS GET "/api/v1/ustva/expenses?companyId=$C"
assert_eq "open ones unlocked, paid and AfA locked" \
  "$(py 'print(sorted(((e["invoiceNumber"] or "AfA"), bool(e.get("lockReason"))) for e in d))')" \
  "[('AfA', True), ('ER-1', False), ('ER-BAR', True), ('ER-SEPA', False), ('GS-1', False)]"

note "=== an open expense is still deleted ==="
AS DELETE "/api/v1/ustva/expenses/$OPEN?companyId=$C"
assert_eq "delete of an open expense" "$STATUS" "200"

summary
