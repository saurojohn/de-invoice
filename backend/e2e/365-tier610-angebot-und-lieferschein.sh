#!/bin/bash
# Tier 610 — quotes (Angebote) and delivery notes (Lieferscheine)
#
# There was the invoice, the credit note, the Proforma and the receipt — no
# quote before the order and no delivery note with the goods. Both are now
# document types of their own (QU → AN-…, DN → LS-…): with a number circle
# and a short life of their own (quote: draft → offered → accepted | declined,
# delivery note: draft → delivered), and with nothing an invoice has — no
# payment, credit note, e-invoice, GiroCode or payment link, and no place in
# any figure: UStVA, DATEV, aging, P&L, dashboard and the customer report are
# the same with a quote over a million as without it. A quote becomes an
# invoice or a delivery note, an issued invoice a delivery note; the new
# document knows where it came from.
#
# Found alongside: the customer report counted every document of a customer —
# a draft and a cancelled invoice as "pending" — and a paid invoice replaced
# the sum paid so far instead of adding to it.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-365-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F); YEAR=${TODAY:0:4}; MONTH=$((10#${TODAY:5:2}))
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
company() { # suffix → U C
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier610-e2e\",\"companyName\":\"$TAG $1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  fixture_issuer "$C"
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
doc() { # type [unitPrice] [customer] → I
  AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'${3:-$K}'","type":"'$1'","issueDate":"'$TODAY'","dueDate":"2099-01-31","items":[{"description":"Ware","quantity":1,"unit":"Stk","unitPrice":'${2:-100}',"vatRate":0.19}]}'
  I=$(json_field "$BODY" id)
}
status() { AS PUT "/api/v1/invoices/$1/status?companyId=$C" '{"status":"'$2'"}'; }
of() { q "select $2 from \"Invoice\" where id='$1'"; }
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }

company a
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Kunde","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"},"contact":{"email":"kunde@example.test"}}'; K=$(json_field "$BODY" id)
AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Zweiter","type":"business","address":{"street":"Ring 3","postalCode":"80331","city":"München","country":"DE"}}'; K2=$(json_field "$BODY" id)

note "=== 1. a number circle of their own ==="
doc QU; QU1=$I
assert_eq "a quote: 201, AN-$YEAR-000001, a draft (was: 400, no such type)" "$STATUS $(of "$QU1" '"invoiceNumber", status, type' 2>/dev/null)" "201 AN-$YEAR-000001|draft|QU"
doc QU; QU2=$I
doc DN; DN1=$I
assert_eq "the second quote and the first delivery note" "$(of "$QU2" '"invoiceNumber"') $(of "$DN1" '"invoiceNumber"')" "AN-$YEAR-000002 LS-$YEAR-000001"
doc INV; INV1=$I
assert_eq "the invoices keep their own circle" "$(of "$INV1" '"invoiceNumber"')" "INV-$YEAR-000001"

note "=== 2. a life of their own ==="
for s in sent paid overdue delivered accepted; do status "$QU1" $s; R="${R:-}$STATUS "; done
assert_eq "a quote draft is not sent / paid / overdue / delivered / accepted" "$R$(of "$QU1" status)" "400 400 400 400 400 draft"
status "$QU1" offered;  assert_eq "…it is offered" "$STATUS $(of "$QU1" status)" "200 offered"
status "$QU1" accepted; assert_eq "…and accepted" "$STATUS $(of "$QU1" status)" "200 accepted"
status "$QU1" offered;  assert_eq "an accepted quote is not offered again" "$STATUS/$(echo "$BODY" | grep -c 'möglich: cancelled')" "400/1"
status "$QU2" offered; status "$QU2" declined; status "$QU2" accepted
assert_eq "a declined quote stays declined" "$STATUS $(of "$QU2" status)" "400 declined"
status "$DN1" offered;   A=$STATUS
status "$DN1" sent;      B=$STATUS
status "$DN1" delivered
assert_eq "a delivery note is not offered or sent — it is delivered" "$A $B $STATUS $(of "$DN1" status)" "400 400 200 delivered"
status "$INV1" offered
assert_eq "an invoice is not offered" "$STATUS/$(echo "$BODY" | grep -c 'gibt es nur bei einem Angebot')/$(of "$INV1" status)" "400/1/draft"

note "=== 3. not an invoice ==="
doc QU; QU3=$I; status "$QU3" offered
AS POST "/api/v1/invoices/$QU3/payments?companyId=$C" '{"amount":50,"paymentDate":"'$TODAY'","paymentMethod":"bank_transfer"}'
assert_eq "no payment on a quote" "$STATUS/$(q "select count(*) from \"Payment\" where \"invoiceId\"='$QU3'")" "400/0"
AS POST "/api/v1/invoices/$DN1/payments?companyId=$C" '{"amount":50,"paymentDate":"'$TODAY'","paymentMethod":"bank_transfer"}'
assert_eq "…nor on a delivery note" "$STATUS" "400"
AS POST "/api/v1/invoices/$QU3/credit-note?companyId=$C" '{"reason":"x"}'
assert_eq "no credit note to a quote" "$STATUS/$(q "select count(*) from \"Invoice\" where \"companyId\"='$C' and type='CN'")" "400/0"
for p in xrechnung "pdf?format=xrechnung" zugferd xrechnung/validate girocode.png; do
  sep='?'; [[ "$p" == *\?* ]] && sep='&'
  AS GET "/api/v1/invoices/$QU3/$p${sep}companyId=$C"; E="${E:-}$STATUS "
done
assert_eq "no XRechnung (both routes), ZUGFeRD, validation or GiroCode" "$E" "400 400 400 400 400 "
AS POST "/api/v1/invoices/$QU3/generate-payment-link?companyId=$C" '{}'
assert_eq "no payment link" "$STATUS/$(q "select count(*) from \"InvoicePaymentLink\" where \"invoiceId\"='$QU3'" 2>/dev/null || echo 0)" "400/0"
for id in "$QU3" "$DN1"; do
  curl -sS -o "/tmp/$TAG.pdf" -w "%{http_code}" "$API/api/v1/invoices/$id/pdf?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" > "/tmp/$TAG.code"
  P="${P:-}$(cat "/tmp/$TAG.code")/$(head -c 4 "/tmp/$TAG.pdf")/$(grep -ac 'factur-x.xml' "/tmp/$TAG.pdf") "
done
rm -f "/tmp/$TAG.pdf" "/tmp/$TAG.code"
assert_eq "the PDF of both: a plain PDF, no e-invoice inside" "$P" "200/%PDF/0 200/%PDF/0 "

note "=== 4. the next document ==="
AS POST "/api/v1/invoices/$QU3/convert?companyId=$C" '{"to":"INV"}'; NEWINV=$(json_field "$BODY" id)
assert_eq "quote → invoice: a draft invoice with the next invoice number, dated today, same sum" \
  "$STATUS $(of "$NEWINV" "type, status, \"invoiceNumber\", \"issueDate\"::date, total::numeric(12,2), \"sourceDocumentId\"")" \
  "201 INV|draft|INV-$YEAR-000002|$TODAY|119.00|$QU3"
assert_eq "…the offered quote is accepted" "$(of "$QU3" status)" "accepted"
AS GET "/api/v1/invoices/$NEWINV?companyId=$C"
assert_eq "the invoice names its quote" "$(field "d['sourceDocument']['invoiceNumber']")" "$(of "$QU3" '"invoiceNumber"')"
AS POST "/api/v1/invoices/$QU3/convert?companyId=$C" '{"to":"DN"}'; NEWDN=$(json_field "$BODY" id)
assert_eq "quote → delivery note" "$STATUS $(of "$NEWDN" 'type, status, "invoiceNumber"')" "201 DN|draft|LS-$YEAR-000002"
AS GET "/api/v1/invoices/$QU3?companyId=$C"
assert_eq "the quote lists what was made from it" "$(field "' '.join(x['type'] for x in d['derivedDocuments'])")" "INV DN"
AS POST "/api/v1/invoices/$INV1/convert?companyId=$C" '{"to":"DN"}'
assert_eq "a draft invoice has no delivery note yet" "$STATUS" "400"
status "$INV1" sent
AS POST "/api/v1/invoices/$INV1/convert?companyId=$C" '{"to":"DN"}'
assert_eq "an issued invoice → delivery note" "$STATUS $(field "d['type'] + ' ' + d['sourceDocument']['invoiceNumber']")" "201 DN INV-$YEAR-000001"
AS POST "/api/v1/invoices/$DN1/convert?companyId=$C" '{"to":"INV"}'; A=$STATUS
AS POST "/api/v1/invoices/$INV1/convert?companyId=$C" '{"to":"QU"}'; B=$STATUS
AS POST "/api/v1/invoices/$QU2/convert?companyId=$C" '{"to":"INV"}'
assert_eq "not: delivery note → invoice, invoice → quote, a declined quote → invoice" "$A $B $STATUS" "400 400 400"
UA=$U; CA=$C
company b
AS POST "/api/v1/invoices/$QU3/convert?companyId=$C" '{"to":"INV"}'
assert_eq "another company does not convert this quote" "$STATUS/$(q "select count(*) from \"Invoice\" where \"sourceDocumentId\"='$QU3'")" "404/2"
U=$UA; C=$CA

note "=== 5. no figure moves ==="
figures() {
  local out=""
  for p in "ustva/compute?year=$YEAR&month=$MONTH" "reports/aging" "reports/pnl?year=$YEAR" "reports/dashboard" \
           "reports/customers?startDate=$YEAR-01-01&endDate=$YEAR-12-31" "reminders/overdue" "reminders/stats" \
           "accounting/euer?year=$YEAR" "reports/datev-preview?from=$YEAR-01-01&to=$YEAR-12-31" "invoices?limit=200" "customers?limit=50"; do
    AS GET "/api/v1/$p&companyId=$C"
    out+="$STATUS $(echo "$BODY" | sed -E 's/"(generatedAt|timestamp|asOf|exportedAt|updatedAt)":"[^"]*"//g')"$'\n'
  done
  echo "$out" | shasum | cut -d' ' -f1
}
BEFORE=$(figures)
doc QU 1000000; BIG=$I; status "$BIG" offered
doc DN 1000000; BIGDN=$I; status "$BIGDN" delivered
doc QU 500000   # a draft
assert_eq "a quote and a delivery note over 1 190 000 € are issued" "$(of "$BIG" 'status, total::numeric(12,2)') $(of "$BIGDN" status)" "offered|1190000.00 delivered"
assert_eq "UStVA, aging, P&L, dashboard, customer report, reminders, EÜR, DATEV, invoice list, customer list: unchanged" "$(figures)" "$BEFORE"
AS GET "/api/v1/invoices?companyId=$C&limit=200"
assert_eq "the invoice list has no quote and no delivery note" "$(field "sorted(set(x['type'] for x in d['data']))")" "['INV']"
AS GET "/api/v1/invoices?companyId=$C&limit=200&type=QU"
assert_eq "…they are listed when asked for" "$(field "sorted(set(x['type'] for x in d['data'])), len(d['data'])")" "(['QU'], 5)"
AS GET "/api/v1/reports/dashboard-v2?companyId=$C"
assert_eq "the dashboard's recent activity is invoices" "$(field "sorted(set(x['invoiceNumber'][:3] for x in d['recentActivity']))")" "['INV']"

note "=== 6. by e-mail ==="
doc QU; QM=$I
AS POST "/api/v1/invoices/$QM/send-email?companyId=$C" '{}'
assert_eq "sending a quote draft offers it (was not possible: 'sent' is no status of a quote)" "$STATUS $(of "$QM" status)" "201 offered"
assert_eq "…with the text of a quote" "$(field "d['subject'].split(' ')[0]")/$(q "select count(*) from \"EmailSend\" where \"invoiceId\"='$QM' and \"bodyPreview\" like '%unser Angebot%' and \"bodyPreview\" not like '%Rechnung%'" 2>/dev/null)" "Angebot/1"
doc DN; DM=$I
AS POST "/api/v1/invoices/$DM/send-email?companyId=$C" '{}'
assert_eq "a delivery note goes out as delivered" "$STATUS $(of "$DM" status) $(field "d['subject'].split(' ')[0]")" "201 delivered Lieferschein"

note "=== 7. the customer report counts what was invoiced ==="
doc INV 100 "$K2"; S1=$I; status "$S1" sent      # 119 open
doc INV 200 "$K2"; S2=$I; status "$S2" sent      # 238, 38 paid
AS POST "/api/v1/invoices/$S2/payments?companyId=$C" '{"amount":38,"paymentDate":"'$TODAY'","paymentMethod":"bank_transfer"}'
doc INV 50 "$K2"; S3=$I; status "$S3" sent; status "$S3" paid   # 59.50 paid
doc INV 400 "$K2"                                 # a draft
doc INV 300 "$K2"; S5=$I; status "$S5" sent; status "$S5" cancelled
doc QU 900 "$K2"; status "$I" offered
AS GET "/api/v1/reports/customers?companyId=$C&startDate=$YEAR-01-01&endDate=$YEAR-12-31"
assert_eq "three issued invoices: 416,50 invoiced, 97,50 paid, 319,00 open (was: draft, cancelled and quote counted as open)" \
  "$(field "[(c['totalInvoices'], c['totalAmount'], c['paidAmount'], c['pendingAmount'], c['overdueAmount']) for c in d['customers'] if c['customerId']=='$K2']")" \
  "[(3, 416.5, 97.5, 319, 0)]"

note "=== 8. a draft from another day (Tier 613) ==="
old() { AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","type":"'$1'","issueDate":"'$YEAR'-01-15","dueDate":"2099-01-31","items":[{"description":"Ware","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19}]}'; I=$(json_field "$BODY" id); }
old QU; OLDQ=$I; NUM=$(of "$OLDQ" '"invoiceNumber"')
AS PUT "/api/v1/invoices/$OLDQ?companyId=$C" '{"customerId":"'$K'","issueDate":"'$YEAR'-01-15","items":[{"description":"Ware","quantity":1,"unit":"Stk","unitPrice":150,"vatRate":0.19}]}'
assert_eq "a quote draft dated 15.01. is still changed" "$STATUS $(of "$OLDQ" 'total::numeric(12,2)')" "200 178.50"
AS PUT "/api/v1/invoices/$OLDQ?companyId=$C" '{"customerId":"'$K'","type":"INV","issueDate":"'$YEAR'-01-15","items":[{"description":"Ware","quantity":1,"unit":"Stk","unitPrice":150,"vatRate":0.19}]}'
assert_eq "…but does not become an invoice by an edit: it keeps its type and its number" "$(of "$OLDQ" 'type, "invoiceNumber"')" "QU|$NUM"
AS DELETE "/api/v1/invoices/$OLDQ?companyId=$C"
assert_eq "…and deleted (was: 403, only on the day it is dated)" "$STATUS $(q "select count(*) from \"Invoice\" where id='$OLDQ'")" "200 0"
doc QU
assert_eq "its number is used by the next quote" "$(of "$I" '"invoiceNumber"')" "$NUM"
old INV; OLDI=$I
AS DELETE "/api/v1/invoices/$OLDI?companyId=$C"
assert_eq "an invoice draft of another day is not deleted, as before" "$STATUS $(q "select count(*) from \"Invoice\" where id='$OLDI'")" "403 1"
summary
