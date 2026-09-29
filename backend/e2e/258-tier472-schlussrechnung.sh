#!/bin/bash
# Tier 472 — the final invoice (Schlussrechnung) of a Proforma
#
# Tier 470 made a payment on a Proforma an advance payment. Measured before:
# there was no way to settle it (POST …/final-invoice 404), the advance stayed
# in Bilanz 4200 for good, and the settled Proforma still took payments and
# let its payment be deleted.
#
# POST /invoices/:proforma/final-invoice creates a draft with the Proforma's
# lines; issuing it books the advance as a deduction ('Anzahlung' payment)
# and the PDF states it with its tax (§ 14 Abs. 5 Satz 2 UStG).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-258-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier472-e2e\",\"companyName\":\"$TAG Handel\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX","bankName":"Testbank"}}'

AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)
proforma() { # net paid paymentDate
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"type\":\"PI\",\"issueDate\":\"2025-12-01\",\"items\":[{\"description\":\"Maschine\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$1,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  AS POST "/api/v1/invoices/$id/payments?companyId=$C" "{\"amount\":$2,\"paymentDate\":\"$3\",\"paymentMethod\":\"bank_transfer\"}"
  echo "$id"
}
PI=$(proforma 1000 1190 2025-12-10)
[[ -n "$PI" ]] && pass "fixture: Proforma 1 000 + 19 %, paid 1 190 on 10.12.2025" || fail "fixture"

note "=== the final invoice ==="
AS POST "/api/v1/invoices/$PI/final-invoice?companyId=$C" '{"issueDate":"2026-01-15"}'
assert_eq "created (was 404: no such endpoint)" "$STATUS" "201"
INV=$(json_field "$BODY" id)
assert_eq "a draft invoice of the whole delivery, linked to the Proforma" \
  "$(P "'%s/%s/%g/%s' % (d['type'], d['status'], float(d['total']), d.get('advanceInvoiceId') == '$PI')")" "INV/draft/1190/True"
AS POST "/api/v1/invoices/$PI/final-invoice?companyId=$C" '{"issueDate":"2026-01-15"}'
assert_eq "…only one per Proforma" "$STATUS" "400"
AS PUT "/api/v1/invoices/$INV/status?companyId=$C" '{"status":"sent"}'
assert_eq "issued" "$STATUS" "200"
AS GET "/api/v1/invoices/$INV/payments?companyId=$C"
assert_eq "issuing deducted the advance: Anzahlung 1190 on 15.01." \
  "$(P "[(p['paymentMethod'], float(p['amount']), p['paymentDate'][:10]) for p in (d if isinstance(d,list) else d.get('data',d))]")" \
  "[('Anzahlung', 1190.0, '2026-01-15')]"
AS GET "/api/v1/invoices/$INV?companyId=$C"
assert_eq "…so it is paid" "$(P "d['status']")" "paid"

note "=== taxed once ==="
AS GET "/api/v1/ustva/compute?companyId=$C&year=2025&month=12"
assert_eq "12/2025: the advance, 1000 / 190" "$(P "[(r['net'], r['vat']) for r in d['salesByRate'] if abs(r['rate']-0.19)<1e-9]")" "[(1000, 190)]"
AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=1"
assert_eq "01/2026: the delivery less the advance, 0 / 0 (was 1000 / 190 again)" \
  "$(P "[(r['net'], r['vat']) for r in d['salesByRate'] if abs(r['rate']-0.19)<1e-9] or [(0, 0)]")" "[(0, 0)]"

note "=== income once ==="
AS GET "/api/v1/accounting/euer?companyId=$C&year=2026"
assert_eq "EÜR 2026: no income — it arrived in 2025" "$(P "[l['amount'] for l in d['einnahmen'] if l['kennziffer']=='4100'][0]")" "0"

note "=== DATEV: the advance account is released against the Debitor ==="
curl -sS -o /tmp/t472.csv -H "x-user-id: $U" -H "x-company-id: $C" \
  "$API/api/v1/reports/datev-export?companyId=$C&startDate=2026-01-01&endDate=2026-01-31"
DEB=$(datev_rows /tmp/t472.csv | awk -F'\t' '$4=="8400" {print $3}')
assert_eq "the invoice: Debitor an 8400, 1190" "$(datev_rows /tmp/t472.csv | awk -F'\t' '$4=="8400" {print $5":"$6}')" "1190.00:S"
assert_eq "the deduction: 1718 an the same Debitor, 1190 (was no row)" \
  "$(datev_rows /tmp/t472.csv | awk -F'\t' '$3=="1718" {print $4":"$5":"$6}')" "$DEB:1190.00:S"
assert_eq "…and no bank row — no money moved in January" "$(datev_rows /tmp/t472.csv | awk -F'\t' '$3=="1200"' | wc -l | tr -d ' ')" "0"

note "=== Bilanz ==="
AS GET "/api/v1/accounting/bilanz?companyId=$C&year=2026"
assert_eq "4200 Erhaltene Anzahlungen 0 after the final invoice (was 1190)" \
  "$(P "[l['amount'] for s in d['passiva'] for l in s['lines'] if l['position']=='4200'][0]")" "0"

note "=== the PDF states the deduction ==="
curl -sS -o /tmp/t472.pdf -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$INV/pdf?companyId=$C&sign=false"
pdf_text() { python3 - "$1" <<'PY'
import sys, re, zlib
raw = open(sys.argv[1], 'rb').read()
out = []
for m in re.finditer(rb'stream\r?\n(.*?)\r?\nendstream', raw, re.S):
    try: data = zlib.decompress(m.group(1))
    except Exception: continue
    for tj in re.finditer(rb'\[(.*?)\]\s*TJ', data, re.S):
        out.append(''.join(bytes.fromhex(h.decode()).decode('latin-1') for h in re.findall(rb'<([0-9a-fA-F]+)>', tj.group(1))))
print('\n'.join(out))
PY
}
TXT=$(pdf_text /tmp/t472.pdf)
assert_eq "abzgl. Anzahlung with the Proforma's number and date, on one line" "$(echo "$TXT" | grep -c "^abzgl. Anzahlung PI-.* vom 10.12.2025:$")" "1"
assert_eq "…its net and tax: darin netto € 1.000,00, USt 19 %" "$(echo "$TXT" | grep -c "darin netto .*1.000,00, USt 19 %")" "1"
assert_eq "…and Zahlbetrag" "$(echo "$TXT" | grep -c "^Zahlbetrag:")" "1"
assert_eq "no GiroCode for 0,00 € to pay" "$(grep -c "/Subtype /Image" /tmp/t472.pdf)" "0"

note "=== the settled Proforma stays settled ==="
AS POST "/api/v1/invoices/$PI/payments?companyId=$C" '{"amount":10,"paymentDate":"2026-01-20","paymentMethod":"bank_transfer"}'
assert_eq "no further payment on it" "$STATUS" "400"
AS GET "/api/v1/invoices/$PI/payments?companyId=$C"
PAYID=$(P "(d if isinstance(d,list) else d.get('data',d))[0]['id']")
AS DELETE "/api/v1/invoices/$PI/payments/$PAYID?companyId=$C"
assert_eq "its payment cannot be deleted" "$STATUS" "400"
AS POST "/api/v1/invoices/$INV/payments?companyId=$C" '{"amount":1,"paymentDate":"2026-01-20","paymentMethod":"Anzahlung"}'
assert_eq "'Anzahlung' is not entered by hand" "$STATUS" "400"

note "=== a partial advance ==="
PI2=$(proforma 1000 595 2025-12-11)
AS POST "/api/v1/invoices/$PI2/final-invoice?companyId=$C" '{"issueDate":"2026-02-10"}'; INV2=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$INV2/status?companyId=$C" '{"status":"sent"}'
AS GET "/api/v1/invoices/$INV2?companyId=$C"
assert_eq "595 of 1190 deducted: still open" "$(P "d['status']")" "sent"
AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=2"
assert_eq "02/2026: 1000 / 190 less the advance 500 / 95" "$(P "[(r['net'], r['vat']) for r in d['salesByRate'] if abs(r['rate']-0.19)<1e-9]")" "[(500, 95)]"

note "=== Ist-Versteuerung: the deduction is no payment received ==="
AS PUT "/api/v1/companies/$C?companyId=$C" '{"besteuerungsart":"ist"}'
AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=1"
assert_eq "01/2026: nothing (the advance was taxed when received)" \
  "$(P "[(r['net'], r['vat']) for r in d['salesByRate'] if abs(r['rate']-0.19)<1e-9] or [(0, 0)]")" "[(0, 0)]"

summary
