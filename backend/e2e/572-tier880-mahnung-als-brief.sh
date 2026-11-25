#!/bin/bash
# Tier 880 — a Mahnung as a letter by post
#
# Found on the production images (the second walk): a Mahnung existed only as
# an e-mail. A customer without an e-mail address („Kunde hat keine
# E-Mail-Adresse hinterlegt“) or a company without a mail server could not be
# dunned at all — no Mahnung, no fees, no letter to print — although a German
# business often posts its Mahnung, the last one as an Einschreiben.
#
# Now POST /reminders/send takes channel „post“: the Mahnung is recorded with
# its fees and no e-mail; its letter comes from GET mahnungen/:id/pdf.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-572-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier880-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
field() { python3 -c "import json,sys
try: print(json.loads(sys.argv[1]).get(sys.argv[2]))
except Exception: print('-')" "$BODY" "$1"; }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
TODAY=$(TZ=Europe/Berlin date +%F)
# Tier 998: a business is in default 30 days after the due date (§ 286 Abs. 3 BGB) — 60 days
# past it there is interest to ask
ISSUE=$(python3 -c "import datetime;print((datetime.date.fromisoformat('$TODAY')-datetime.timedelta(days=90)).isoformat())")
DUE=$(python3 -c "import datetime;print((datetime.date.fromisoformat('$TODAY')-datetime.timedelta(days=60)).isoformat())")
invoice_for() {
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"$ISSUE\",\"dueDate\":\"$DUE\",\"items\":[{\"description\":\"Montage\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":500,\"vatRate\":0.19}]}"
  I=$(field id)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
}

note "=== 1. a customer with an address and no e-mail ==="
AS POST "/api/v1/customers?companyId=$C" '{"name":"Briefkunde 572 GmbH","type":"business","address":{"street":"Hafenstr. 3","city":"Bremen","postalCode":"28195","country":"DE"}}'
K=$(field id)
invoice_for "$K"; INV=$I
EMAIL_BODY=$(printf '{"companyId":"%s","invoiceId":"%s","level":"first"}' "$C" "$INV")
AS POST "/api/v1/reminders/send" "$EMAIL_BODY"
assert_eq "by e-mail: refused, no address (as before)" "$STATUS $(field message)" "400 Kunde hat keine E-Mail-Adresse hinterlegt"

POST_BODY=$(printf '{"companyId":"%s","invoiceId":"%s","level":"first","channel":"post"}' "$C" "$INV")
AS POST "/api/v1/reminders/send" "$POST_BODY"
M=$(field mahnungId)
assert_eq "as a letter: the Mahnung is made (was: no way to dun this customer)" "$STATUS $(field channel) $(field recipient)" "201 post None"
assert_eq "…and the answer says to print and post it" "$(field message)" "Mahnung als Brief erstellt — bitte drucken und versenden"
assert_eq "the Mahnung row: no e-mail recipient, no EmailSend, its fees" \
  "$(q "select level, recipient_email_empty from (select level, \"recipientEmail\"='' as recipient_email_empty from \"Mahnung\" where id='$M') x")/$(q "select \"emailSendId\" is null from \"Mahnung\" where id='$M'")/$(q "select (\"totalDue\" > 595) from \"Mahnung\" where id='$M'")" \
  "first|t/t/t"
assert_eq "no e-mail recorded for it" "$(q "select count(*) from \"EmailSend\" where \"companyId\"='$C'")" "0"

PDF=$(mktemp)
CODE=$(curl -sS -o "$PDF" -w "%{http_code} %{content_type}" "$API/api/v1/reminders/mahnungen/$M/pdf?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C")
assert_eq "its letter: a PDF" "$CODE $(head -c4 "$PDF")" "200 application/pdf %PDF"
rm -f "$PDF"

AS GET "/api/v1/reminders/mahnungen?companyId=$C"
assert_eq "the Mahnhistorie lists it, recipient empty" \
  "$(python3 -c "import json,sys;d=json.loads(sys.argv[1]);r=d['mahnungen'];print(len(r), repr(r[0]['recipientEmail']))" "$BODY")" "1 ''"
AS GET "/api/v1/reminders/stats?companyId=$C"
assert_eq "the 30-day count has the letter" "$(field recentReminders)" "1"

AS POST "/api/v1/reminders/send" "$POST_BODY"
assert_eq "the same level twice a day: refused, as by e-mail" "$STATUS" "409"

note "=== 2. no address, no letter ==="
# issued to an address, which was removed later (an invoice is not issued without one)
AS POST "/api/v1/customers?companyId=$C" '{"name":"Ohne Anschrift 572","type":"business","address":{"street":"Weg 9","city":"Kiel","postalCode":"24103","country":"DE"}}'
K2=$(field id)
invoice_for "$K2"; INV2=$I
q "update \"Customer\" set address='{\"country\":\"DE\"}'::jsonb where id='$K2'" >/dev/null
B2=$(printf '{"companyId":"%s","invoiceId":"%s","level":"first","channel":"post"}' "$C" "$INV2")
AS POST "/api/v1/reminders/send" "$B2"
assert_eq "a letter without the customer's address: refused, and said why" "$STATUS $(field message | cut -c1-36)" "400 Kunde hat keine Anschrift hinterlegt"
assert_eq "…and no Mahnung recorded" "$(q "select count(*) from \"Mahnung\" where \"invoiceId\"='$INV2'")" "0"

note "=== 3. the channel is checked ==="
B3=$(printf '{"companyId":"%s","invoiceId":"%s","level":"first","channel":"fax"}' "$C" "$INV2")
AS POST "/api/v1/reminders/send" "$B3"
assert_eq "an unknown channel: 400" "$STATUS" "400"
summary
