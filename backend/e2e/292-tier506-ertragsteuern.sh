#!/bin/bash
# Tier 506 — income taxes in a GmbH's GuV and Bilanz
#
# Measured before: the GuV of a Kapitalgesellschaft left position 14
# "Steuern vom Einkommen und Ertrag" empty ("nicht erfasst") — the
# Jahresüberschuss was the result before KSt / Soli / GewSt, ~30 % too high;
# the Bilanz had no Steuerrückstellung and no VAT still owed (both "nicht
# ausgewiesen"), the Saldoposten held them.
#
# Now position 14 = KSt + Soli + GewSt (KSt 1's "Zu zahlen", from the pre-tax
# result, which KSt 1 still starts from); the Bilanz shows the
# Steuerrückstellung (less the GewSt prepayments recorded) and the VAT of the
# year not yet paid (UStVA history) as Sonstige Verbindlichkeiten.
#
# Fixture: a GmbH, one invoice of 10 000 € + 1 900 € VAT in June 2025,
# Hebesatz 400 → KSt 1 500, Soli 82,50, GewSt 1 400 = 2 982,50.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-292-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier506-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C"
[[ -n "${C:-}" ]] && pass "fixture: a GmbH" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH"}'
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2025-06-02\",\"items\":[{\"description\":\"Projekt\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":10000,\"vatRate\":0.19}]}"
AS PUT "/api/v1/invoices/$(json_field "$BODY" id)/status?companyId=$C" '{"status":"sent"}'

note "=== KSt 1 still starts from the pre-tax result ==="
AS GET "/api/v1/accounting/kst1?companyId=$C&year=2025"
assert_eq "zvE 10 000, Zu zahlen 2 982,50 (unchanged)" "$(P "(float(d['totals']['zve']), float(d['totals']['zuZahlen']))")" "(10000.0, 2982.5)"

note "=== GuV ==="
AS GET "/api/v1/accounting/guv?companyId=$C&year=2025"
pos() { P "[l['amount'] for l in d['tax']['lines'] if l['position']=='$1'][0]"; }
assert_eq "position 14: 2 982,50 (was empty — 'nicht erfasst')" "$(pos 14)" "2982.5"
assert_eq "Jahresüberschuss 10 000 − 2 982,50 = 7 017,50 (was 10 000)" "$(P "float(d['totals']['jahresueberschuss'])")" "7017.5"

note "=== Bilanz ==="
B() { AS GET "/api/v1/accounting/bilanz?companyId=$C&year=2025"; P "[None if l['amount'] is None else float(l['amount']) for s in d['$1'] for l in s['lines'] if l['position']=='$2'][0]"; }
assert_eq "Steuerrückstellung 2 982,50 (was not shown)" "$(B passiva 3100)" "2982.5"
assert_eq "Sonstige Verbindlichkeiten: the year's VAT 1 900 not yet paid (was not shown)" "$(B passiva 4600)" "1900.0"
AS PUT "/api/v1/accounting/gewst/settings?companyId=$C" '{"year":2025,"q1":100,"q2":100,"q3":100,"q4":100}'
assert_eq "GewSt prepayments 400 recorded: Rückstellung 2 582,50" "$(B passiva 3100)" "2582.5"
AS GET "/api/v1/ustva/compute?companyId=$C&year=2025&month=6"
AS POST "/api/v1/ustva/filings?companyId=$C" "$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='submitted';print(json.dumps(d))" "$BODY")"
F=$(json_field "$BODY" id)
AS PUT "/api/v1/ustva/filings/$F/payment?companyId=$C" '{"paidAt":"2025-07-10","amount":1900}'
assert_eq "the June VAT paid on 10.07.: nothing owed at year end" "$(B passiva 4600)" "0.0"

note "=== a sole trader: no income taxes in the GuV ==="
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"Einzelunternehmen"}'
AS GET "/api/v1/accounting/guv?companyId=$C&year=2025"
assert_eq "position 14 empty, Jahresüberschuss 10 000" "$(pos 14)/$(P "float(d['totals']['jahresueberschuss'])")" "None/10000.0"

summary
