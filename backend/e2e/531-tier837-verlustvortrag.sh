#!/bin/bash
# Tier 837 — the loss carried forward (the loss-year drill: a GmbH founded
# 2025, 31 000 € loss, 40 000 € profit in 2026 on the production images).
#
# KSt 1 2026 taxed the full 40 000 € — KSt 6 000, Soli 330, GewSt 5 600 —
# instead of the 9 000 € left after the 2025 loss: 1 350 / 74,25 / 1 260. The
# GuV's taxes, the Jahresüberschuss and the Bilanz's Steuerrückstellung were
# 9 245,75 € off. Kz 50 (Verlustabzug) was a placeholder no one could fill in.
#
# Now: the loss of the app's own years is carried forward — KSt by § 10d
# Abs. 2 EStG (1 Mio € in full, beyond it 70 % in 2024–2027), GewSt by § 10a
# GewStG (1 Mio €, beyond it 60 %) — on KSt 1 (and so the GuV and the Bilanz)
# and on the GewSt form; the figures of the Verlustfeststellungsbescheid,
# entered, replace the app's own.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-531-$(date +%s%N | cut -c1-13)"
register() {
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$1@example.test\",\"password\":\"Tier837-e2e\",\"companyName\":\"$1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])"
}
AS() {
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
setup() { # tag → U C, a GmbH with one customer (CUST)
  read -r U C < <(register "$1")
  [[ -n "${C:-}" ]] && pass "fixture: company $1" || { fail "register"; summary; exit 1; }
  fixture_issuer "$C"
  AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"GmbH"}'
  AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde","type":"business","address":{"street":"Teststr. 9","postalCode":"10115","city":"Berlin","country":"DE"}}'
  CUST=$(json_field "$BODY" id)
}
revenue() { # date net
  AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$CUST'","issueDate":"'$1'","items":[{"description":"Leistung","quantity":1,"unit":"Stk","unitPrice":'$2',"vatRate":0.19}]}'
  local i; i=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$i/status?companyId=$C" '{"status":"sent"}'
  assert_status 200 "fixture: revenue $2 € on $1"
}
cost() { # date net
  local vat; vat=$(python3 -c "print(round($2*0.19,2))"); local gross; gross=$(python3 -c "print(round($2*1.19,2))")
  AS POST "/api/v1/expenses?companyId=$C" '{"description":"Werbung","invoiceNumber":"W-'$1'","invoiceDate":"'$1'","netAmount":'$2',"vatRate":0.19,"vatAmount":'$vat',"grossAmount":'$gross',"category":"Werbung"}'
  assert_status 201 "fixture: a cost of $2 € on $1"
}
kst1() { AS GET "/api/v1/accounting/kst1?companyId=$C&year=$1"; }
T='t=d["totals"];v=d["verlustvortrag"];kz50=[l["amount"] for l in d["corrections"] if l["kennziffer"]=="50"][0]'

note "=== 1. a loss year, then a profit year ==="
setup "$TAG-a"
revenue 2025-08-15 10000
cost 2025-05-10 41000
revenue 2026-03-15 40000
kst1 2025
assert_eq "2025: zvE −31 000, no tax; carried on: KSt 31 000, GewSt 31 000" \
  "$(py "$T;print('%.2f %.2f %.2f %.2f %.2f' % (t['zve'], t['kst'], t['gewst'], v['kst']['ende'], v['gewst']['ende']))")" "-31000.00 0.00 0.00 31000.00 31000.00"
kst1 2026
assert_eq "2026: Kz 50 −31 000 (was 0), from the app's own 2025" \
  "$(py "$T;print('%.2f' % kz50, v['kst']['quelle'], '%.2f %.2f' % (v['kst']['anfang'], v['kst']['ende']))")" "-31000.00 berechnet 31000.00 0.00"
assert_eq "2026: zvE 9 000, KSt 1 350, Soli 74,25 (were 40 000 / 6 000 / 330)" \
  "$(py "$T;print('%.2f %.2f %.2f' % (t['zve'], t['kst'], t['soli']))")" "9000.00 1350.00 74.25"
assert_eq "2026: GewSt — Gewerbeertrag 40 000 − Fehlbetrag 31 000: Messbetrag 315, at 400 % 1 260 (was 5 600)" \
  "$(py "$T;print('%.2f %.2f %.2f' % (t['gewstMessbetrag'], t['gewst'], v['gewst']['abzug']))")" "315.00 1260.00 31000.00"
AS GET "/api/v1/accounting/guv?companyId=$C&year=2026"
assert_eq "the GuV 2026: Jahresüberschuss 40 000 − 2 684,25 (was 28 070)" "$(py "print('%.2f' % d['totals']['jahresueberschuss'])")" "37315.75"
AS GET "/api/v1/accounting/bilanz?companyId=$C&year=2026"
assert_eq "the Bilanz 2026: Steuerrückstellungen 2 684,25 (was 11 930)" \
  "$(py "print(['%.2f' % l['amount'] for s in d['passiva'] for l in s['lines'] if l['position']=='3100'][0])")" "2684.25"
AS GET "/api/v1/accounting/gewst?companyId=$C&year=2026"
assert_eq "the GewSt form 2026: Gewerbeertrag nach Freibetrag 9 000, GewSt 1 260; Fehlbetrag 31 000 berechnet, used up" \
  "$(py "f=d['fehlbetrag'];print('%.2f %.2f' % (d['gewerbeertragNachFreibetrag'], d['totals']['festzusetzendeGewerbesteuer']), f['quelle'], '%.2f %.2f' % (f['abzug'], f['ende']))")" "9000.00 1260.00 berechnet 31000.00 0.00"

note "=== 2. the Bescheid's figures replace the app's own ==="
AS PUT "/api/v1/accounting/kst1/verlustvortrag?companyId=$C" '{"year":2026,"kst":20000,"gewst":25000}'
assert_status 200 "the Verlustvortrag at 31.12.2025 as the Bescheid states it: KSt 20 000, GewSt 25 000"
kst1 2026
assert_eq "KSt 1 2026: zvE 20 000, KSt 3 000, Soli 165, GewSt (15 000 × 3,5 % × 400 %) 2 100" \
  "$(py "$T;print('%.2f %.2f %.2f %.2f' % (t['zve'], t['kst'], t['soli'], t['gewst']), v['kst']['quelle'], v['gewst']['quelle'])")" "20000.00 3000.00 165.00 2100.00 bescheid bescheid"
AS GET "/api/v1/accounting/gewst?companyId=$C&year=2026"
assert_eq "the GewSt form takes the Bescheid's Fehlbetrag too" "$(py "print('%.2f' % d['totals']['festzusetzendeGewerbesteuer'], d['fehlbetrag']['quelle'])")" "2100.00 bescheid"
AS PUT "/api/v1/accounting/kst1/verlustvortrag?companyId=$C" '{"year":2026,"kst":null,"gewst":null}'
assert_status 200 "the entry cleared"
kst1 2026
assert_eq "back to the app's own 2025: zvE 9 000" "$(py "$T;print('%.2f' % t['zve'], v['kst']['quelle'])")" "9000.00 berechnet"
AS PUT "/api/v1/accounting/kst1/verlustvortrag?companyId=$C" '{"year":2026,"kst":-5}'
assert_status 400 "a negative Verlustvortrag is refused"
AS PUT "/api/v1/accounting/kst1/verlustvortrag?companyId=$C" '{"year":2026,"kst":"zehn"}'
assert_status 400 "a text is refused"

note "=== 3. Mindestbesteuerung beyond 1 Mio € — 70 % (KSt, 2024–2027), 60 % (GewSt) ==="
setup "$TAG-b"
cost 2024-06-01 2000000
revenue 2025-06-01 1500000
kst1 2025
assert_eq "KSt: 1 000 000 + 70 % × 500 000 = 1 350 000 deducted, 650 000 carried on; zvE 150 000, KSt 22 500" \
  "$(py "$T;print('%.2f %.2f %.2f %.2f' % (v['kst']['abzug'], v['kst']['ende'], t['zve'], t['kst']))")" "1350000.00 650000.00 150000.00 22500.00"
assert_eq "GewSt: 1 000 000 + 60 % × 500 000 = 1 300 000 deducted, 700 000 carried on; Messbetrag 7 000, GewSt 28 000" \
  "$(py "$T;print('%.2f %.2f %.2f %.2f' % (v['gewst']['abzug'], v['gewst']['ende'], t['gewstMessbetrag'], t['gewst']))")" "1300000.00 700000.00 7000.00 28000.00"
AS GET "/api/v1/accounting/gewst?companyId=$C&year=2025"
assert_eq "the GewSt form: the same 60 %" "$(py "print('%.2f %.2f' % (d['fehlbetrag']['abzug'], d['totals']['festzusetzendeGewerbesteuer']))")" "1300000.00 28000.00"

note "=== 4. not in a year whose books are closed ==="
AS PUT "/api/v1/accounting/books-closing?companyId=$C" '{"closedUntil":"2025-12-31"}'
assert_status 200 "fixture: the books closed until 31.12.2025"
AS PUT "/api/v1/accounting/kst1/verlustvortrag?companyId=$C" '{"year":2025,"kst":1}'
assert_status 400 "the Verlustvortrag of 2025 can no longer be changed"
AS PUT "/api/v1/accounting/kst1/verlustvortrag?companyId=$C" '{"year":2026,"kst":650000,"gewst":700000}'
assert_status 200 "the one of 2026 can"
summary
