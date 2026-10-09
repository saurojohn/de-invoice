#!/bin/bash
# Tier 614 — the order confirmation (Auftragsbestätigung)
#
# Between the quote and the invoice there was nothing to send the customer
# when the order came in. An order confirmation is a third non-fiscal
# document type (OC → AB-YYYY-NNNNNN): draft → confirmed (→ cancelled). It is
# made from a quote (which becomes "accepted") or written directly, and
# becomes an invoice and a delivery note. Like a quote it takes no payment,
# credit note, e-invoice, GiroCode, payment link, voucher, pause or reminder,
# is in no figure and not in the customer's portal.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-368-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); YEAR=${TODAY:0:4}; MONTH=$((10#${TODAY:5:2}))
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
doc() { # type [unitPrice] [date] → I
  AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","type":"'$1'","issueDate":"'${3:-$TODAY}'","dueDate":"2099-01-31","items":[{"description":"Ware","quantity":1,"unit":"Stk","unitPrice":'${2:-100}',"vatRate":0.19}]}'
  I=$(json_field "$BODY" id)
}
status() { AS PUT "/api/v1/invoices/$1/status?companyId=$C" '{"status":"'$2'"}'; }
convert() { AS POST "/api/v1/invoices/$1/convert?companyId=$C" '{"to":"'$2'"}'; N=$(json_field "$BODY" id); }
of() { q "select $2 from \"Invoice\" where id='$1'"; }
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier614-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Kunde","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"},"contact":{"email":"'$TAG'-kunde@example.test"}}'; K=$(json_field "$BODY" id)

note "=== 1. a document of its own ==="
doc OC; OC1=$I
assert_eq "an order confirmation: 201, AB-$YEAR-000001, a draft (was: 400, no such type)" "$STATUS $(of "$OC1" '"invoiceNumber", status, type' 2>/dev/null)" "201 AB-$YEAR-000001|draft|OC"
for s in sent paid offered accepted delivered; do status "$OC1" $s; R="${R:-}$STATUS "; done
assert_eq "it is not sent, paid, offered, accepted or delivered" "$R$(of "$OC1" status)" "400 400 400 400 400 draft"
status "$OC1" confirmed; A="$STATUS $(of "$OC1" status)"
status "$OC1" draft
assert_eq "it is confirmed, and stays so" "$A / $STATUS $(of "$OC1" status)" "200 confirmed / 400 confirmed"
doc INV; INV=$I; status "$INV" confirmed
assert_eq "an invoice is not 'confirmed'" "$STATUS $(of "$INV" status)" "400 draft"

note "=== 2. from the quote to the invoice ==="
doc QU; QU=$I; status "$QU" offered
convert "$QU" OC; OC2=$N
assert_eq "quote → order confirmation: a draft with the next AB number, the quote's sum, linked back" \
  "$STATUS $(of "$OC2" "type, status, \"invoiceNumber\", total::numeric(12,2), \"sourceDocumentId\"")" "201 OC|draft|AB-$YEAR-000002|119.00|$QU"
assert_eq "…the offered quote is accepted" "$(of "$QU" status)" "accepted"
status "$OC2" confirmed
convert "$OC2" INV; NEWINV=$N
assert_eq "order confirmation → invoice: a draft invoice, linked to the confirmation" \
  "$STATUS $(of "$NEWINV" "type, status, total::numeric(12,2), \"sourceDocumentId\"")" "201 INV|draft|119.00|$OC2"
convert "$OC2" DN
assert_eq "order confirmation → delivery note" "$STATUS $(of "$N" 'type, status')" "201 DN|draft"
AS GET "/api/v1/invoices/$OC2?companyId=$C"
assert_eq "the confirmation names its quote and what was made from it" "$(field "d['sourceDocument']['type'] + ' ' + ' '.join(x['type'] for x in d['derivedDocuments'])")" "QU INV DN"
convert "$OC2" QU; A=$STATUS
convert "$OC2" OC; B=$STATUS
convert "$INV" OC; D=$STATUS
status "$OC1" cancelled; convert "$OC1" INV
assert_eq "not: confirmation → quote, → confirmation, invoice → confirmation, a cancelled confirmation → invoice" "$A $B $D $STATUS" "400 400 400 400"

note "=== 3. not an invoice ==="
doc OC 1000000; BIG=$I
AS POST "/api/v1/invoices/$BIG/payments?companyId=$C" '{"amount":50,"paymentDate":"'$TODAY'","paymentMethod":"bank_transfer"}'; E="$STATUS "
AS POST "/api/v1/invoices/$BIG/credit-note?companyId=$C" '{"reason":"x"}'; E+="$STATUS "
for p in xrechnung "pdf?format=xrechnung" zugferd xrechnung/validate girocode.png; do
  sep='?'; [[ "$p" == *\?* ]] && sep='&'
  AS GET "/api/v1/invoices/$BIG/$p${sep}companyId=$C"; E+="$STATUS "
done
AS POST "/api/v1/invoices/$BIG/generate-payment-link?companyId=$C" '{}'; E+="$STATUS "
AS POST "/api/v1/accounting/vouchers/generate/$BIG?companyId=$C" '{}'; E+="$STATUS "
AS POST "/api/v1/mahnungspausen?companyId=$C" '{"invoiceId":"'$BIG'","reason":"x"}'; E+="$STATUS "
AS GET "/api/v1/reminders/$BIG/email-data?companyId=$C&level=first"; E+="$STATUS"
assert_eq "no payment, credit note, XRechnung (both routes), ZUGFeRD, validation, GiroCode, payment link, voucher, pause, reminder text" \
  "$E" "400 400 400 400 400 400 400 400 400 400 400"
curl -sS -o "/tmp/$TAG.pdf" -w "%{http_code}" "$API/api/v1/invoices/$OC2/pdf?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" > "/tmp/$TAG.code"
assert_eq "its PDF: a plain PDF, no e-invoice inside" "$(cat "/tmp/$TAG.code")/$(head -c 4 "/tmp/$TAG.pdf")/$(grep -ac 'factur-x.xml' "/tmp/$TAG.pdf")" "200/%PDF/0"
rm -f "/tmp/$TAG.pdf" "/tmp/$TAG.code"

note "=== 4. no figure moves ==="
figures() {
  local out=""
  for p in "ustva/compute?year=$YEAR&month=$MONTH" "reports/aging" "reports/pnl?year=$YEAR" "reports/dashboard" "reports/dashboard-v2" \
           "reports/customers?startDate=$YEAR-01-01&endDate=$YEAR-12-31" "reminders/overdue" "reminders/stats" \
           "accounting/euer?year=$YEAR" "reports/datev-preview?from=$YEAR-01-01&to=$YEAR-12-31" "invoices?limit=200" "customers?limit=50" "customers/$K/summary?x=1"; do
    AS GET "/api/v1/$p&companyId=$C"
    out+="$STATUS $(echo "$BODY" | sed -E 's/"(generatedAt|timestamp|asOf|exportedAt|updatedAt)":"[^"]*"//g')"$'\n'
  done
  echo "$out" | shasum | cut -d' ' -f1
}
status "$INV" sent
BEFORE=$(figures)
status "$BIG" confirmed
doc OC 500000
assert_eq "a confirmed order over 1 190 000 € and a draft: UStVA, aging, P&L, both dashboards, customer report, reminders, EÜR, DATEV, invoice list, customer list and summary unchanged" "$(figures)" "$BEFORE"
AS GET "/api/v1/invoices?companyId=$C&limit=200&type=OC"
assert_eq "the confirmations are listed when asked for" "$(field "sorted(set(x['type'] for x in d['data'])), len(d['data'])")" "(['OC'], 4)"
AS POST "/api/v1/customer-portal/admin/create-session" '{"customerId":"'$K'"}'
TOKEN=$(echo "$BODY" | grep -oE '[0-9a-f]{64}' | head -1)
assert_eq "the customer's portal lists the invoice, no confirmation; by id 404" \
  "$(curl -sS "$API/api/v1/customer-portal/invoices?token=$TOKEN" | python3 -c "import sys,json;d=json.load(sys.stdin);r=d.get('invoices',d.get('data',d));print(sorted(set(x['type'] for x in r)))" 2>/dev/null) $(curl -sS -o /dev/null -w '%{http_code}' "$API/api/v1/customer-portal/invoice/$BIG?token=$TOKEN")" \
  "['INV'] 404"

note "=== 5. by e-mail; an old draft ==="
doc OC; OM=$I
AS POST "/api/v1/invoices/$OM/send-email?companyId=$C" '{}'
assert_eq "sending a draft confirms it, with the confirmation's text" \
  "$STATUS $(of "$OM" status) $(field "d['subject'].split(' ')[0]")/$(q "select count(*) from \"EmailSend\" where \"invoiceId\"='$OM' and \"bodyPreview\" like '%vielen Dank für Ihren Auftrag%'")" "201 confirmed Auftragsbestätigung/1"
doc OC 100 "$YEAR-01-15"; OLD=$I; NUM=$(of "$OLD" '"invoiceNumber"')
AS DELETE "/api/v1/invoices/$OLD?companyId=$C"
doc OC
assert_eq "a draft confirmation of another day is deleted, and its number used again" "$STATUS $(q "select count(*) from \"Invoice\" where id='$OLD'") $(of "$I" '"invoiceNumber"')" "201 0 $NUM"
summary
