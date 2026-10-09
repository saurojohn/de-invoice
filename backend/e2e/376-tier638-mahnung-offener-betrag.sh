#!/bin/bash
# Tier 638 — a reminder asks for what is open, and says when the invoice was written
#
# Dunning was reconciled by hand: an invoice over 1 190 €, issued on the 17th,
# due on the 31st, 190 € paid. The fees and the interest were right (Tier 421:
# on the open 1 000 €). Measured around them:
#   GET /reminders/:id/email-data — the text every reminder e-mail is made of
#        (by hand, in bulk, by the nightly run):
#          "die Rechnung … vom 31. August 2026 mit einem Betrag von EUR 1190.00"
#        the due date as the invoice's date, the invoice's total as the amount
#        — while the PDF attached to the same e-mail says 1 000 €.
#   GET /reminders/stats    → totalOverdueAmount 2380 for two such invoices
#   GET /reminders/overdue  → "total": "1190" and nothing else to show
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-376-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
day() { python3 -c "import datetime;print((datetime.date.today()-datetime.timedelta(days=$1)).isoformat())"; }
long() { python3 -c "
import datetime,sys
d=datetime.date.fromisoformat(sys.argv[1])
print('%02d. %s %d' % (d.day, ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'][d.month-1], d.year))" "$1"; }
ISSUED=$(day 54); DUE=$(day 40); PAID=$(day 25)
text() { AS GET "/api/v1/reminders/$1/email-data?companyId=$C&level=$2"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier638-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS POST "/api/v1/customers?companyId=$C" '{"name":"'$TAG' Kunde","type":"business","address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"},"contact":{"email":"'$TAG'-kunde@example.test"}}'; K=$(json_field "$BODY" id)
invoice() { # → I, issued, overdue
  AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$ISSUED'","dueDate":"'$DUE'","items":[{"description":"Leistung","quantity":1,"unit":"Stk","unitPrice":1000,"vatRate":0.19}]}'
  I=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
}
invoice; A=$I
AS POST "/api/v1/invoices/$A/payments?companyId=$C" '{"amount":190,"paymentDate":"'$PAID'","paymentMethod":"bank_transfer"}'
invoice; B=$I
assert_eq "fixture: two invoices over 1 190 €, overdue; 190 € paid on the first" "$STATUS $(q "select count(*)||'/'||sum(total)::numeric(10,2) from \"Invoice\" where \"companyId\"='$C' and status='sent'")" "200 2/2380.00"

note "=== 1. the text of the reminder ==="
text "$A" first
assert_eq "the first reminder: what is open, the invoice's date, the due date (was: 'vom <due date> mit einem Betrag von EUR 1190.00')" \
  "$STATUS $(echo "$BODY" | grep -c "aus der Rechnung .* vom $(long "$ISSUED"), fällig am $(long "$DUE"), noch 1.000,00 EUR offen sind")" "200 1"
assert_eq "…and the invoice's total is nowhere in it" "$(echo "$BODY" | grep -cE '1190|1\.190')" "0"
text "$A" second; S2=$(field "d['body'].count('Offener Betrag: 1.000,00 EUR'), d['body'].count('vom $(long "$ISSUED"), fällig am $(long "$DUE")')")
text "$A" final;  S3=$(field "d['body'].count('Offener Betrag: 1.000,00 EUR'), d['body'].count('vom $(long "$ISSUED"), fällig am $(long "$DUE")')")
assert_eq "the second and the last reminder say the same" "$S2 $S3" "(1, 1) (1, 1)"
text "$B" first
assert_eq "an invoice nothing was paid on: its total" "$(echo "$BODY" | grep -c 'noch 1.190,00 EUR offen sind')" "1"
AS POST "/api/v1/invoices/$A/credit-note?companyId=$C" '{"reason":"Nachlass","amount":119}'
text "$A" first
assert_eq "a credit note over 119 € on the first: 881 € are open" "$STATUS $(echo "$BODY" | grep -c 'noch 881,00 EUR offen sind')" "200 1"
AS GET "/api/v1/reminders/mahnungen/fees-preview?companyId=$C&invoiceId=$A&level=first"
assert_eq "…as the fees are computed on (Tier 421)" "$(field "d['openBalance']")" "881"

note "=== 2. the list and its sum ==="
AS GET "/api/v1/reminders/overdue?companyId=$C"
assert_eq "the overdue list has what is open next to the total (was: the total only)" \
  "$(field "sorted((x['total'], x['openAmount']) for x in d)")" "[('1190', '1190'), ('1190', '881')]"
AS GET "/api/v1/reminders/stats?companyId=$C"
assert_eq "the overdue sum is the open one (was: 2380)" "$(field "d['overdueCount'], d['totalOverdueAmount']")" "(2, '2071')"

note "=== 3. templates ==="
AS GET "/api/v1/reminders/templates/second?companyId=$C"
assert_eq "an unedited template is the default" "$(field "d['isDefault'], '{{openAmount}}' in d['body'], '{{totalAmount}}' in d['body']")" "(True, True, False)"
q "update \"ReminderTemplate\" set body='Fälliger Betrag: EUR {{totalAmount}}' where \"companyId\"='$C' and level='second'" >/dev/null
AS GET "/api/v1/reminders/templates/second?companyId=$C"
assert_eq "…and a copy of an older default, never edited, follows it (the rows seeded before this tier)" "$(field "d['isDefault'], '{{openAmount}}' in d['body']")" "(True, True)"
AS PUT "/api/v1/reminders/templates/final?companyId=$C" '{"subject":"Letzte Mahnung {{invoiceNumber}}","body":"Zu zahlen: {{totalAmount}} | offen: {{openAmount}} | Rechnung: {{invoiceTotal}} vom {{issueDateFormatted}} | fällig {{dueDateFormatted}} | {{unbekannt}}"}'
text "$A" final
assert_eq "an edited template: {{totalAmount}} is the amount to pay, {{invoiceTotal}} the invoice's; an unknown token stays" \
  "$STATUS $(field "d['body']")" "200 Zu zahlen: 881,00 | offen: 881,00 | Rechnung: 1.190,00 vom $(long "$ISSUED") | fällig $(long "$DUE") | {{unbekannt}}"
AS GET "/api/v1/reminders/templates/final?companyId=$C"
assert_eq "…and it stays as edited" "$(field "d['isDefault'], d['body'][:10]")" "(False, 'Zu zahlen:')"

note "=== 4. what is sent ==="
AS POST "/api/v1/reminders/send" '{"companyId":"'$C'","invoiceId":"'$A'","level":"first"}'
assert_eq "the reminder that goes out has that text" \
  "$STATUS $(q "select count(*) from \"EmailSend\" where \"invoiceId\"='$A' and \"templateType\"='reminder_first' and \"bodyPreview\" like '%noch 881,00 EUR offen sind%'")" "201 1"
assert_eq "…and its Mahnung row the same amount to pay: 881 € and the fees" \
  "$(q "select (\"totalDue\" - \"mahngebuehr\" - \"verzugszins\")::numeric(10,2) from \"Mahnung\" where \"invoiceId\"='$A'")" "881.00"
summary
