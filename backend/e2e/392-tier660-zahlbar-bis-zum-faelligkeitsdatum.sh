#!/bin/bash
# Tier 660 — the invoice says when it is due
#
# The PDF's payment line was the template's sentence, "Zahlbar binnen 14
# Tagen ohne Abzug.", on every invoice. A customer with 30 days' payment
# terms got an invoice due on the 30th day — which the reminders go by — that
# said 14 days; the due date stood nowhere on the page; with Skonto a second
# line named another date ("… bis 11.11. ohne Abzug"); and a credit note
# asked to be paid within 14 days.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-392-$(date +%s%N | cut -c1-13)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"; rm -f "$SCRIPT_DIR/../.tier660-probe.ts"' EXIT
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
cat > "$TMP/pdftext.py" <<'PY'
import re, sys, zlib
d = open(sys.argv[1], 'rb').read()
out = []
for m in re.finditer(rb'stream\r?\n(.*?)endstream', d, re.S):
    try: t = zlib.decompress(m.group(1))
    except Exception: continue
    for arr in re.findall(rb'\[((?:<[0-9a-fA-F]*>|[-0-9. ]+)+)\]\s*TJ', t):
        out.append(b''.join(bytes.fromhex(h.decode()) for h in re.findall(rb'<([0-9a-fA-F]*)>', arr)).decode('cp1252', 'replace'))
print('\n'.join(out).replace(' ', ' '))
PY
LINES() { # invoice id → the lines of its PDF that speak of paying
  curl -sS -o "$TMP/x.pdf" "$API/api/v1/invoices/$1/pdf?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C"
  python3 "$TMP/pdftext.py" "$TMP/x.pdf" | grep -i "zahlbar\|fällig am\|skonto" | tr '\n' '|'
}
TODAY=$(TZ=Europe/Berlin date +%F)
de() { python3 -c "import datetime,sys; d=datetime.date.fromisoformat('$TODAY')+datetime.timedelta(days=$1); print(d.strftime('%d.%m.%Y'))"; }

note "=== 1. the sentence, case by case ==="
cat > "$SCRIPT_DIR/../.tier660-probe.ts" <<'TS'
import { paymentTermsLine } from './src/invoices/invoice-pdf.service'
const inv = (due: string | null, type = 'INV') => ({ type, issueDate: '2026-10-12T00:00:00.000Z', dueDate: due && `${due}T00:00:00.000Z` })
const out: Array<[string, string | null]> = [
  ['plain', paymentTermsLine(inv('2026-11-11'), undefined, 'INV', false)],
  ['stock', paymentTermsLine(inv('2026-11-11'), 'Zahlbar binnen 14 Tagen ohne Abzug.', 'INV', false)],
  ['stock2', paymentTermsLine(inv('2026-11-11'), 'Zahlbar innerhalb von 30 Tagen ohne Abzug', 'INV', false)],
  ['preset', paymentTermsLine(inv('2026-11-11'), 'Zahlbar bis zum {dueDate} ohne Abzug.', 'INV', true)],
  ['today', paymentTermsLine(inv('2026-10-12'), undefined, 'INV', false)],
  ['skonto', paymentTermsLine(inv('2026-11-11'), 'Zahlbar binnen 14 Tagen ohne Abzug.', 'INV', true)],
  ['credit', paymentTermsLine(inv('2026-10-12', 'CN'), 'Zahlbar binnen 14 Tagen ohne Abzug.', 'CN', false)],
  ['own', paymentTermsLine(inv('2026-11-11'), 'Bitte überweisen Sie bis {dueDate} ({days} Tage).', 'INV', false)],
  ['ownNoDate', paymentTermsLine(inv('2026-11-11'), 'Zahlung per Überweisung.', 'INV', false)],
  ['ownSkonto', paymentTermsLine(inv('2026-11-11'), 'Zahlung per Überweisung.', 'INV', true)],
  ['order', paymentTermsLine(inv('2026-11-11'), undefined, 'OC', false)],
  ['noDue', paymentTermsLine(inv(null), undefined, 'INV', false)],
]
for (const [k, v] of out) console.log(`${k}=${v}`)
TS
( cd "$SCRIPT_DIR/.." && npx ts-node -T .tier660-probe.ts > "$TMP/probe.txt" 2>&1 )
P() { grep "^$1=" "$TMP/probe.txt" | head -1 | cut -d= -f2-; }
assert_eq "an invoice due on 11.11." "$(P plain)" "Zahlbar bis zum 11.11.2026 ohne Abzug."
assert_eq "a template that still has the stock sentence" "$(P stock)" "Zahlbar bis zum 11.11.2026 ohne Abzug."
assert_eq "… in its other wording" "$(P stock2)" "Zahlbar bis zum 11.11.2026 ohne Abzug."
assert_eq "the new preset sentence with Skonto: the Skonto line alone" "$(P preset)" "null"
assert_eq "due on the day it is written" "$(P today)" "Zahlbar sofort ohne Abzug."
assert_eq "with Skonto: no second sentence — the Skonto line names both dates" "$(P skonto)" "null"
assert_eq "a credit note is not to be paid" "$(P credit)" "null"
assert_eq "the company's own text, with the date and the days filled in" "$(P own)" "Bitte überweisen Sie bis 11.11.2026 (30 Tage)."
assert_eq "its own text without a date: the due date follows" "$(P ownNoDate)" "Zahlung per Überweisung. Fällig am 11.11.2026."
assert_eq "… not when the Skonto line names it" "$(P ownSkonto)" "Zahlung per Überweisung."
assert_eq "an order confirmation states the term, not a date" "$(P order)" "Zahlbar binnen 30 Tagen nach Rechnungsdatum ohne Abzug."
assert_eq "no due date, nothing said about one" "$(P noDue)" "null"

note "=== 2. on the PDFs ==="
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier660-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS POST "/api/v1/customers?companyId=$C" '{"name":"Dreißig Tage GmbH","type":"business","paymentTerms":30,"address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"}}'; K=$(field "d['id']")
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$TODAY'","items":[{"description":"Ware","quantity":1,"unit":"Stk","unitPrice":1000,"vatRate":0.19}]}'; I1=$(field "d['id']")
assert_eq "fixture: a customer with 30 days' terms — the invoice is due in 30 days" "$(field "d['dueDate'][:10]")" "$(python3 -c "import datetime;print(datetime.date.fromisoformat('$TODAY')+datetime.timedelta(days=30))")"
AS PUT "/api/v1/invoices/$I1/status?companyId=$C" '{"status":"sent"}' >/dev/null
assert_eq "its PDF says that date (was: Zahlbar binnen 14 Tagen ohne Abzug.)" "$(LINES "$I1")" "Zahlbar bis zum $(de 30) ohne Abzug.|"
AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$TODAY'","skontoPercent":2,"skontoDays":10,"items":[{"description":"Ware","quantity":1,"unit":"Stk","unitPrice":1000,"vatRate":0.19}]}'; I2=$(field "d['id']")
AS PUT "/api/v1/invoices/$I2/status?companyId=$C" '{"status":"sent"}' >/dev/null
assert_eq "with Skonto: one line, two dates (was: two lines, 14 days and the 30th day)" "$(LINES "$I2")" "Zahlbar bis $(de 10) mit 2% Skonto, bis $(de 30) ohne Abzug.|"
AS POST "/api/v1/invoices/$I1/credit-note?companyId=$C" '{"amount":119,"reason":"Nachlass"}'; CN=$(field "d['id']")
assert_eq "a credit note is written" "$STATUS" "201"
assert_eq "its PDF asks for no payment (was: Zahlbar binnen 14 Tagen ohne Abzug.)" "$(LINES "$CN")" ""

note "=== 3. the templates ==="
assert_eq "no preset template is created with the 14 days any more" \
  "$(grep -c "paymentTermsText: 'Zahlbar binnen 14 Tagen" "$SCRIPT_DIR/../src/modules/invoice-template/invoice-template.service.ts")/$(grep -c "paymentTermsText: 'Zahlbar bis zum {dueDate} ohne Abzug.'" "$SCRIPT_DIR/../src/modules/invoice-template/invoice-template.service.ts")" "0/4"
grep -q 'paymentTermsHint' "$SCRIPT_DIR/../../frontend/src/app/dashboard/invoice-templates/page.tsx" \
  && pass "the template editor says what {dueDate} and {days} do" || fail "no hint in the template editor"

summary
