#!/bin/bash
# Tier 410 — a 0 % line stays 0 %
#
# invoice.service.ts wrote `item.vatRate || 0.19` in twelve places, and 0 is
# falsy. Measured, exactly as the invoice form sends them (choosing Reverse
# Charge or innergemeinschaftliche Lieferung sets every line to 0):
#   igL invoice, 1 000 € net           → VAT 190, total 1 190, line rate 0.19
#   §13b reverse charge, 1 000 € net   → VAT 190, total 1 190, line rate 0.19
#   a 0 % line (§4 steuerfrei), 100 €  → VAT 19
# An invoice that states VAT owes it (§ 14c UStG) whether or not it was due,
# the EU business customer was billed German VAT on a tax-free supply, and the
# invoice contradicted itself (flagged tax-free, VAT on it). The product CSV
# import had the same `|| 0.19`.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-199-$(date +%s%N | cut -c1-13)"
TODAY=$(date +%F)
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier410-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG DE\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)
AS POST "/api/v1/customers?companyId=$C" \
  "{\"name\":\"$TAG FR SARL\",\"type\":\"business\",\"vatId\":\"FR12345678901\",\"address\":{\"street\":\"1\",\"city\":\"Paris\",\"postalCode\":\"75001\",\"country\":\"FR\"}}"
KEU=$(json_field "$BODY" id)
[[ -n "$K" && -n "$KEU" ]] && pass "fixture: a domestic and an EU business customer" || fail "customers: $BODY"
TOTALS() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print('%s/%s/%s/%s' % (float(d['subtotal']), float(d['totalVat']), float(d['total']), float(d['items'][0]['vatRate'])))" "$BODY"; }

note "=== 1. tax-free supplies, as the form sends them ==="
AS POST "/api/v1/invoices?companyId=$C" \
  "{\"customerId\":\"$KEU\",\"issueDate\":\"2026-08-15\",\"euTransaction\":true,\"items\":[{\"description\":\"$TAG Maschine\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0}]}"
IGL=$(json_field "$BODY" id)
assert_eq "igL: net/VAT/total/rate (was 1000/190/1190/0.19)" "$(TOTALS)" "1000.0/0.0/1000.0/0.0"
AS POST "/api/v1/invoices?companyId=$C" \
  "{\"customerId\":\"$KEU\",\"issueDate\":\"2026-08-15\",\"reverseCharge\":true,\"items\":[{\"description\":\"$TAG Montage\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0}]}"
assert_eq "§13b reverse charge (was 1000/190/1190/0.19)" "$(TOTALS)" "1000.0/0.0/1000.0/0.0"

note "=== 2. a 0 % line on an ordinary invoice, and the default ==="
AS POST "/api/v1/invoices?companyId=$C" \
  "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"$TAG steuerfrei\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0}]}"
ZERO=$(json_field "$BODY" id)
assert_eq "a single 0 % line: no VAT (was 19)" "$(TOTALS)" "100.0/0.0/100.0/0.0"
AS POST "/api/v1/invoices?companyId=$C" \
  "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"$TAG a\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19},{\"description\":\"$TAG b\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0}]}"
assert_eq "19 % + 0 %: VAT only on the taxable line (was 38)" "$(json_field "$BODY" totalVat)" "19"
AS POST "/api/v1/invoices?companyId=$C" \
  "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"$TAG ohne Satz\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100}]}"
assert_eq "no rate given still defaults to 19 %" "$(TOTALS)" "100.0/19.0/119.0/0.19"

note "=== 3. a same-day edit keeps 0 % ==="
AS PUT "/api/v1/invoices/$ZERO?companyId=$C" \
  "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"$TAG steuerfrei\",\"quantity\":2,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0}]}"
assert_status 200 "the edit"
assert_eq "…the edited invoice has no VAT (was 38)" \
  "$(sql "SELECT \"totalVat\"::numeric || '/' || total::numeric FROM \"Invoice\" WHERE id = '$ZERO';")" "0.0000/200.0000"
assert_eq "…and its line is still 0 %" \
  "$(sql "SELECT \"vatRate\"::numeric FROM \"InvoiceItem\" WHERE \"invoiceId\" = '$ZERO';")" "0.0000"

note "=== 4. the UStVA sees the igL invoice as igL, not as 19 % turnover ==="
AS PUT "/api/v1/invoices/$IGL/status?companyId=$C" '{"status":"sent"}'
AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=8"
assert_eq "igL bucket: 1000" "$(json_field "$BODY" igL)" "1000"
assert_eq "no 19 % output VAT from it (was 190)" "$(json_field "$BODY" umsatzsteuer)" "0"
assert_eq "…and it is not filed as 'sonstige steuerfreie Umsätze' either (was, even at 0 %)" "$(json_field "$BODY" otherExempt)" "0"

note "=== 4b. EÜR files zero-VAT revenue by what it is ==="
# Before this tier the §19 (Kleinunternehmer) line took every zero-VAT invoice
# and ran first, so an igL sale — once it really was 0 % — would have been
# reported as Kleinunternehmer revenue.
# Tier 454: the EÜR counts what was paid — the customers pay.
AS POST "/api/v1/invoices/$IGL/payments?companyId=$C" '{"amount":1000,"paymentDate":"'$TODAY'","paymentMethod":"bank_transfer"}'
assert_status 201 "fixture: the igL invoice paid"
EUR_LINE() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(next((l['amount'] for l in d['einnahmen'] if l['kennziffer']==sys.argv[2]),'-'))" "$BODY" "$1"; }
AS GET "/api/v1/accounting/euer?companyId=$C&year=2026"
assert_eq "igL revenue on the tax-free line 4170" "$(EUR_LINE 4170)" "1000"
assert_eq "…not on the §19 line 4120" "$(EUR_LINE 4120)" "0"
# A company that IS a Kleinunternehmer: its zero-VAT revenue is §19 revenue.
read -r UK CK < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG-ku@example.test\",\"password\":\"Tier410-e2e\",\"companyName\":\"$TAG KU\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
KU() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $UK" -H "x-company-id: $CK" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
KU PUT "/api/v1/companies/$CK?companyId=$CK" '{"defaultVatMode":"kleinunternehmer"}'
assert_status 200 "fixture: a Kleinunternehmer company"
KU POST "/api/v1/customers?companyId=$CK" "{\"name\":\"$TAG KU Kunde\",\"type\":\"individual\"}"; KK=$(json_field "$BODY" id)
KU POST "/api/v1/invoices?companyId=$CK" "{\"customerId\":\"$KK\",\"issueDate\":\"2026-08-15\",\"items\":[{\"description\":\"Kurs\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":300,\"vatRate\":0}]}"
KINV=$(json_field "$BODY" id)
assert_eq "…its invoice carries no VAT" "$(json_field "$BODY" totalVat)" "0"
KU PUT "/api/v1/invoices/$KINV/status?companyId=$CK" '{"status":"sent"}'
KU POST "/api/v1/invoices/$KINV/payments?companyId=$CK" '{"amount":300,"paymentDate":"2026-08-20","paymentMethod":"cash"}'
KU GET "/api/v1/accounting/euer?companyId=$CK&year=2026"
assert_eq "…and its revenue is on the §19 line 4120" "$(EUR_LINE 4120)" "300"
assert_eq "…not on the tax-free line" "$(EUR_LINE 4170)" "0"

note "=== 5. the product import keeps a 0 % rate ==="
AS POST "/api/v1/products/import?companyId=$C" \
  "{\"rows\":[{\"name\":\"$TAG Buch\",\"sku\":\"$TAG-0\",\"basePrice\":\"20\",\"vatRate\":\"0\"},{\"name\":\"$TAG Sonst\",\"sku\":\"$TAG-x\",\"basePrice\":\"20\",\"vatRate\":\"abc\"}]}"
assert_eq "both rows imported" "$(json_field "$BODY" imported)" "2"
assert_eq "an explicit 0 stays 0 (was 0.19)" \
  "$(sql "SELECT \"vatRate\"::numeric FROM \"Product\" WHERE \"companyId\" = '$C' AND name = '$TAG Buch';")" "0.0000"
assert_eq "an unparseable rate still falls back to 19 %" \
  "$(sql "SELECT \"vatRate\"::numeric FROM \"Product\" WHERE \"companyId\" = '$C' AND name = '$TAG Sonst';")" "0.1900"

note "=== 6. no falsy default on a VAT rate is left ==="
# Comment lines are skipped — the explanation of the bug quotes the pattern.
LEFT=$(grep -rnE "vatRate\)? *\|\| *0?\.[0-9]|\) *\|\| *0\.19\b" "$SCRIPT_DIR/../src" --include='*.ts' \
  | grep -v '\.test\.ts' | grep -vE '^[^:]+:[0-9]+: *(\*|//)' || true)
[[ -z "$LEFT" ]] && pass "no \`|| 0.19\` on a VAT rate anywhere in src" || fail "falsy defaults remain: $LEFT"

summary; exit $?
