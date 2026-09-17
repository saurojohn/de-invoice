#!/bin/bash
# Tier 409 — tax figures are per rate and after the invoice discount
#
# Every tax figure was built from the stored line amounts, which are the lines
# BEFORE the invoice-level discount. Measured with one invoice — 1 000 € net,
# 10 % discount, 19 % VAT, customer pays 1 071 €:
#   UStVA           net 1 000, VAT 190                  (owed: 900 / 171)
#   DATEV revenue   1 000 on 8125 (tax-free intra-EU), key 0 — the blended
#                   rate 171/1 000 = 0.171 is neither 19 % nor 7 %; the 100 €
#                   discount was never booked, the receivable did not clear
# and a 19 % + 7 % invoice WITHOUT any discount hit the same branch: its whole
# revenue went to the tax-free EU account with key 0.
# The VAT report also counted drafts, and the update path stored discounted
# line amounts where create stored undiscounted ones.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-198-$(date +%s%N | cut -c1-13)"
TODAY=$(date +%F)
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier409-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG DE\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)
paid() { # body-fragment → prints invoice id
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"2026-08-15\",$2}"
  local id total
  id=$(json_field "$BODY" id); total=$(json_field "$BODY" total)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  AS POST "/api/v1/invoices/$id/payments?companyId=$C" "{\"amount\":$total,\"paymentDate\":\"2026-08-20\",\"paymentMethod\":\"bank_transfer\"}"
  echo "$id"
}
A=$(paid "$K" '"discountPercent":10,"items":[{"description":"Beratung","quantity":1,"unit":"Stk","unitPrice":1000,"vatRate":0.19}]')
B=$(paid "$K" '"items":[{"description":"Leistung","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19},{"description":"Buch","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.07}]')
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-08-16\",\"items\":[{\"description\":\"$TAG Entwurf\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":500,\"vatRate\":0.19}]}"
[[ -n "$A" && -n "$B" ]] && pass "fixture: a discounted invoice, a mixed-rate invoice (both paid), a draft" || fail "fixtures"

note "=== 1. UStVA ==="
AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=8"
RATE() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);r=[x for x in d['salesByRate'] if abs(x['rate']-float(sys.argv[2]))<1e-6];print('%s/%s'%(r[0]['net'],r[0]['vat']) if r else '-')" "$BODY" "$1"; }
# 19 %: invoice A after discount (900/171) + B's 19 % line (100/19)
assert_eq "19 %: net/VAT (was 1100/209 — A counted before its discount)" "$(RATE 0.19)" "1000/190"
assert_eq "7 %: net/VAT" "$(RATE 0.07)" "100/7"
assert_eq "USt total = 171 + 19 + 7" "$(json_field "$BODY" umsatzsteuer)" "197"

note "=== 2. the VAT report agrees, and leaves the draft out ==="
AS GET "/api/v1/reports/vat?companyId=$C&year=2026&month=8"
VR() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);r=[x for x in d['byRate'] if abs(x['vatRate']-float(sys.argv[2]))<1e-6];print('%s/%s'%(r[0]['netAmount'],r[0]['vatAmount']) if r else '-')" "$BODY" "$1"; }
assert_eq "19 % — the 500 € draft is not in it (was)" "$(VR 0.19)" "1000/190"
assert_eq "7 %" "$(VR 0.07)" "100/7"

note "=== 3. DATEV books each rate on its own account, and each invoice balances ==="
curl -sS -o "$SCRIPT_DIR/../.t198.csv" "$API/api/v1/reports/datev-export?companyId=$C&startDate=2026-08-01&endDate=2026-08-31" \
  -H "x-user-id: $U" -H "x-company-id: $C"
DATEV() { python3 - "$SCRIPT_DIR/../.t198.csv" "$1" <<'PY'
import csv, io, sys
from collections import defaultdict
rows = list(csv.reader(io.StringIO(open(sys.argv[1], 'rb').read().decode('latin-1')), delimiter=';'))[1:]
rows = [r for r in rows if len(r) > 12]
q = sys.argv[2]
if q == 'accounts':
    print(' '.join(sorted({f"{r[2].strip()}:{r[7]}:{float(r[8]):.2f}:{r[11] or '-'}" for r in rows if r[5] == 'H'})))
elif q == 'balance':
    per = defaultdict(float)
    for r in rows:
        per[r[2].strip()] += float(r[8]) if r[5] == 'S' else -float(r[8])
    print(' '.join(f"{k}:{v:.2f}" for k, v in sorted(per.items())))
elif q == '8125':
    print(sum(1 for r in rows if r[7] == '8125'))
PY
}
ACC=$(DATEV accounts)
note "revenue/VAT rows: $ACC"
[[ "$ACC" == *"INV-2026-000001:8400:900.00:1"* ]] && pass "A: 900 revenue on 8400 (19 %), key 1 (was 1 000 on 8125, key 0)" || fail "A revenue row: $ACC"
[[ "$ACC" == *"INV-2026-000001:1776:171.00:1"* ]] && pass "A: 171 VAT on 1776 (19 %)" || fail "A VAT row: $ACC"
[[ "$ACC" == *"INV-2026-000002:8400:100.00:1"* && "$ACC" == *"INV-2026-000002:1776:19.00:1"* ]] \
  && pass "B: the 19 % part on 8400 / 1776, key 1" || fail "B 19 % rows: $ACC"
[[ "$ACC" == *"INV-2026-000002:8300:100.00:2"* && "$ACC" == *"INV-2026-000002:1760:7.00:2"* ]] \
  && pass "B: the 7 % part on 8300 / 1760, key 2 (was: all on 8125, key 0)" || fail "B 7 % rows: $ACC"
assert_eq "nothing domestic lands on the tax-free intra-EU account 8125" "$(DATEV 8125)" "0"
assert_eq "each invoice balances: payment in = revenue + VAT (A was 100 short)" \
  "$(DATEV balance)" "INV-2026-000001:0.00 INV-2026-000002:0.00"
rm -f "$SCRIPT_DIR/../.t198.csv"

note "=== 4. OSS uses the discounted amounts ==="
AS POST "/api/v1/customers?companyId=$C" \
  "{\"name\":\"$TAG AT\",\"type\":\"individual\",\"address\":{\"street\":\"1\",\"city\":\"Wien\",\"postalCode\":\"1010\",\"country\":\"Österreich\"}}"
KAT=$(json_field "$BODY" id)
[[ -n "$KAT" ]] && pass "fixture: an Austrian private customer" || fail "AT customer: $BODY"
paid "$KAT" '"discountPercent":10,"items":[{"description":"Kurs","quantity":1,"unit":"Stk","unitPrice":200,"vatRate":0.19}]' >/dev/null
AS GET "/api/v1/reports/oss?companyId=$C&year=2026&quarter=3"
AT=$(python3 -c "
import sys,json
d=json.loads(sys.argv[1])
c=[x for x in d.get('countries',[]) if x.get('countryCode')=='AT' or x.get('country')=='AT']
print('%.2f/%.2f' % (c[0]['netAmount'], c[0]['vatAmount']) if c else 'none: %s' % [ (x.get('countryCode'), x.get('country')) for x in d.get('countries',[])])
" "$BODY")
assert_eq "AT: 180 net / 34.20 VAT (was 200 / 38)" "$AT" "180.00/34.20"

note "=== 5. saving an invoice unchanged does not change its lines ==="
AS POST "/api/v1/invoices?companyId=$C" \
  "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"discountPercent\":10,\"items\":[{\"description\":\"$TAG edit\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
E=$(json_field "$BODY" id)
LINE() { sql "SELECT \"netAmount\"::numeric || '/' || \"vatAmount\"::numeric FROM \"InvoiceItem\" WHERE \"invoiceId\" = '$E';"; }
BEFORE=$(LINE)
AS PUT "/api/v1/invoices/$E?companyId=$C" \
  "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"discountPercent\":10,\"items\":[{\"description\":\"$TAG edit\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
assert_status 200 "an unchanged same-day save"
assert_eq "the line still reads $BEFORE (the update path used to store 900/171)" "$(LINE)" "$BEFORE"
assert_eq "…and the invoice totals are unchanged" \
  "$(sql "SELECT subtotal::numeric || '/' || \"totalVat\"::numeric || '/' || total::numeric FROM \"Invoice\" WHERE id = '$E';")" \
  "1000.0000/171.0000/1071.0000"

summary; exit $?
