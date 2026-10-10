#!/bin/bash
# Tier 646 — the customer statement is from the company that sends it; the
# statement and the reminder letter are one page
#
# The two PDFs a customer gets besides the invoice were opened. Measured:
#   GET /customers/:id/statement.pdf — letterhead "SH Leder GmbH · Otto-Hahn-
#        Str. 24 · 63303 Dreieich", footer with that company's tax number, VAT
#        id, bank and IBAN, the PDF's author the same: written into the source,
#        on the statement of every company.
#   …and a second page that held the footer line alone; so did every reminder
#        letter (GET /reminders/mahnungen/:id/pdf): text written below the
#        bottom margin makes pdfkit start a page.
#   The statement's rows, newest first: two payments of one day stood in
#        their ascending order, and the Saldo column jumped.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-382-$(date +%s%N | cut -c1-13)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
day() { python3 -c "import datetime;print((datetime.date.today()-datetime.timedelta(days=$1)).isoformat())"; }
pages() { python3 -c "
import re,sys
d=open(sys.argv[1],'rb').read()
print(d[:4].decode('latin1'), len(re.findall(rb'/Type\s*/Page\b(?!s)', d)))" "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier646-e2e\",\"companyName\":\"$TAG Handel GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C" DE811907980
AS POST "/api/v1/customers?companyId=$C" '{"name":"Muster GmbH","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"},"contact":{"email":"'$TAG'-kunde@example.test"}}'; K=$(json_field "$BODY" id)
invoice() { # issue due → I
  AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$1'","dueDate":"'$2'","items":[{"description":"Leistung","quantity":1,"unit":"Stk","unitPrice":1000,"vatRate":0.19}]}'
  I=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
}
invoice "$(day 60)" "$(day 40)"; A=$I
invoice "$(day 55)" "2099-12-31"; B=$I
# two payments on one day, and one more
AS POST "/api/v1/invoices/$A/payments?companyId=$C" '{"amount":100,"paymentDate":"'$(day 30)'","paymentMethod":"bank_transfer"}'
AS POST "/api/v1/invoices/$B/payments?companyId=$C" '{"amount":250,"paymentDate":"'$(day 30)'","paymentMethod":"bank_transfer"}'
AS POST "/api/v1/invoices/$A/payments?companyId=$C" '{"amount":90,"paymentDate":"'$(day 20)'","paymentMethod":"bank_transfer"}'
assert_eq "fixture: two invoices, three payments — two of them on one day" "$STATUS $(q "select count(*) from \"Payment\" p join \"Invoice\" i on i.id=p.\"invoiceId\" where i.\"companyId\"='$C'")" "201 3"
RANGE="from=$(day 90)&to=$(day 0)"

note "=== 1. the statement is the sending company's ==="
AS GET "/api/v1/customers/$K/statement?companyId=$C&$RANGE"
assert_eq "the statement names its sender: the company, its tax number and VAT id" \
  "$STATUS $(field "d['company']['name'], d['company']['taxId'], d['company']['vatId'], d['company']['address'].get('city')")" \
  "200 ('$TAG Handel GmbH', '12/345/67890', 'DE811907980', 'Berlin')"
assert_eq "newest first, the Saldo column runs: each row's balance is the one below it plus the row's amount (was: two payments of one day in the wrong order)" \
  "$(field "len(d['lines']), all(abs(d['lines'][i]['balance'] - (d['lines'][i+1]['balance'] + d['lines'][i]['amount'])) < 0.005 for i in range(len(d['lines'])-1)), d['lines'][0]['balance'] == d['closingBalance']")" "(5, True, True)"
AS GET "/api/v1/customers/$K/statement?companyId=$C&$RANGE&order=asc"
assert_eq "…and oldest first likewise" \
  "$(field "all(abs(d['lines'][i+1]['balance'] - (d['lines'][i]['balance'] + d['lines'][i+1]['amount'])) < 0.005 for i in range(len(d['lines'])-1)), d['lines'][-1]['balance'] == d['closingBalance']")" "(True, True)"
curl -sS -o "$TMP/statement.pdf" "$API/api/v1/customers/$K/statement.pdf?companyId=$C&$RANGE" -H "x-user-id: $U" -H "x-company-id: $C"
assert_eq "the PDF is one page (was: two — the footer alone on the second)" "$(pages "$TMP/statement.pdf")" "%PDF 1"
assert_eq "its author is the company (was: 'SH Leder GmbH' for everyone)" "$(grep -ac "($TAG Handel GmbH)" "$TMP/statement.pdf")/$(grep -ac '(SH Leder GmbH)' "$TMP/statement.pdf")" "1/0"
cd "$SCRIPT_DIR/.."
assert_eq "no company's name, address or numbers are written into the PDF's source" \
  "$(grep -v '^\s*\*\|^\s*//' src/modules/customer/customer-statement-pdf.service.ts | grep -cE "SH Leder|Otto-Hahn|Dreieich|DE308630106|044 243|IBAN DE[0-9]")" "0"

note "=== 2. the invoice's signature ==="
# Every invoice PDF is signed when it is downloaded. The signature's signer,
# contact and place were written into the source as well: "SH Leder GmbH",
# "info@shleder.de", "Stuttgart" — on the invoices of every company.
curl -sS -o "$TMP/invoice.pdf" "$API/api/v1/invoices/$B/pdf?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C"
assert_eq "the signature names the company that issued the invoice, and its town (was: another company's name, e-mail address and town)" \
  "$(grep -a -o '/Name ([^)]*)' "$TMP/invoice.pdf" | head -1) $(grep -a -o '/Location ([^)]*)' "$TMP/invoice.pdf" | head -1) $(grep -ac 'shleder\|SH Leder\|Stuttgart' "$TMP/invoice.pdf")" \
  "/Name ($TAG Handel GmbH) /Location (Berlin) 0"
assert_eq "no company's name, e-mail address or town are written into the signing source" \
  "$(grep -v '^\s*\*\|^\s*//' src/modules/signing/signing.service.ts | grep -cE "SH Leder|shleder|'Stuttgart'")" "0"

note "=== 3. the reminder letter ==="
AS POST "/api/v1/reminders/send" '{"companyId":"'$C'","invoiceId":"'$A'","level":"second"}'
M=$(json_field "$BODY" mahnungId)
assert_eq "a reminder is sent for the overdue invoice" "$STATUS $([[ -n "$M" ]] && echo id)" "201 id"
curl -sS -o "$TMP/mahnung.pdf" "$API/api/v1/reminders/mahnungen/$M/pdf?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C"
assert_eq "the letter is one page (was: two — the footer alone on the second)" "$(pages "$TMP/mahnung.pdf")" "%PDF 1"
summary
