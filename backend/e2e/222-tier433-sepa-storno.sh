#!/bin/bash
# Tier 433 — a SEPA batch the bank did not execute can be cancelled
#
# Measured before: there was no way to. Once generated, a batch's expenses
# stayed "paid" (paidAt, paidBySepaBatchId) — in the balance sheet, on the
# payments page (not in the unpaid list any more) and, since Tier 432, in
# DATEV — whatever the bank did with the file.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-222-$(date +%s%N | cut -c1-13)"
TODAY=$(date +%F); FROM=$(date +%Y-%m-01); YEAR=$(date +%Y)

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier433-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
AS POST "/api/v1/suppliers?companyId=$C" "{\"name\":\"$TAG Lieferant\",\"address\":{\"street\":\"a\",\"city\":\"b\",\"postalCode\":\"1\",\"country\":\"DE\"},\"bankInfo\":{\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\"}}"
S=$(json_field "$BODY" id)
expense() { AS POST "/api/v1/ustva/expenses?companyId=$C" "{\"supplierId\":\"$S\",\"invoiceNumber\":\"$1\",\"description\":\"$1\",\"invoiceDate\":\"$TODAY\",\"netAmount\":100,\"vatRate\":0.19,\"vatAmount\":19,\"grossAmount\":119}"; json_field "$BODY" id; }
batch() { AS POST "/api/v1/payments/batches" "{\"companyId\":\"$C\",\"expenseIds\":[\"$1\"],\"executionDate\":\"$TODAY\",\"debtorIban\":\"DE02120300000000202051\",\"debtorName\":\"$TAG GmbH\"}"; json_field "$BODY" id; }
bilanz4000() { AS GET "/api/v1/accounting/bilanz?companyId=$C&year=$YEAR"; P "[l['amount'] for s in d['passiva'] for l in s['lines'] if l['position']=='4000'][0]"; }

E=$(expense ER-1); B=$(batch "$E")
assert_eq "fixture: paid by the batch, nothing owed" "$(q "select \"paidAt\" is not null from \"Expense\" where id='$E'")/$(bilanz4000)" "t/0"

note "=== 1. the bank rejected the file ==="
AS POST "/api/v1/payments/batches/$B/cancel" '{"reason":"Bank: IBAN ungültig"}'
assert_eq "cancelled (was: no way to)" "$STATUS/$(P "d['status']")" "201/cancelled"
assert_eq "the expense is unpaid again" "$(q "select (\"paidAt\" is null)::text||'/'||(\"paidBySepaBatchId\" is null)::text from \"Expense\" where id='$E'")" "true/true"
AS GET "/api/v1/payments/unpaid?companyId=$C"
assert_eq "…back in the list of unpaid expenses" "$(P "[x['id'] for x in d]")" "['$E']"
assert_eq "…owed again in the balance sheet" "$(bilanz4000)" "119"
curl -sS -o /tmp/t433.csv -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/reports/datev-export?companyId=$C&startDate=$FROM&endDate=$TODAY"
assert_eq "…and not paid in DATEV" "$(datev_rows /tmp/t433.csv | awk -F'\t' '$3=="1200"' | wc -l | tr -d ' ')" "0"
AS POST "/api/v1/payments/batches/$B/cancel" '{}'
assert_eq "a batch is cancelled once" "$STATUS" "400"

note "=== 2. not once the bank has debited it ==="
E2=$(expense ER-2); B2=$(batch "$E2")
# The bank import matched the debit to the expense (what bookExpense writes).
q "insert into \"Voucher\" (id, \"companyId\", \"voucherNumber\", date, description, \"referenceType\", status, \"createdAt\")
   values (gen_random_uuid()::text, '$C', 'BK-T433', now(), 'Lastschrift [expense:$E2]', 'Expense', 'posted', now())" >/dev/null
AS POST "/api/v1/payments/batches/$B2/cancel" '{}'
assert_eq "refused: the payment is in the bank statement" "$STATUS/$(q "select \"paidAt\" is not null from \"Expense\" where id='$E2'")" "400/t"

summary; exit $?
