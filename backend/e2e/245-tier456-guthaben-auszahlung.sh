#!/bin/bash
# Tier 456 — paying out a customer's credit books the money leaving the bank
#
# Measured before (invoice 119 €, paid 150 €, the 31 € credit paid out):
#   - the payout voucher booked Bank Soll 31 / Forderungen Haben 31 — money
#     coming IN. DATEV: "1200 an 1400 S 31"; the bank at 181 € (150 + 31)
#     instead of 119 €, the customer's Debitor left at −31 (the credit never
#     settled) and a direct posting on the collective account 1400.
#   - a payout above the credit was refused (400) only AFTER its bank
#     voucher had been posted — the voucher stayed.
#   - its Storno put the money back in the books, but the credit ledger kept
#     the payout: balance 0 € while the Debitor owed the customer 31 €.
# Now: Forderungen Soll / Bank Haben; DATEV "Bank an Debitor H", a Storno the
# other way and the credit restored; the balance is checked before anything
# is posted.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-245-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier456-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
AS GET "/api/v1/accounting/accounts/seed?companyId=$C"
AS GET "/api/v1/accounting/accounts?companyId=$C"
BANK=$(py 'print([a["id"] for a in (d if isinstance(d,list) else d.get("data",[])) if a["accountNumber"]=="1200"][0])')
[[ -n "$BANK" ]] && pass "fixture: Sachkonten, Bank 1200" || fail "no bank account: $BODY"
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-07-01\",\"items\":[{\"description\":\"a\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$I/payments?companyId=$C" '{"amount":150,"paymentDate":"2026-07-05","paymentMethod":"bank_transfer"}'
AS GET "/api/v1/customers/$K/credit-balance?companyId=$C"
assert_eq "fixture: 31 € credit from the overpayment" "$(json_field "$BODY" balance)" "31"
vouchers() { AS GET "/api/v1/accounting/vouchers?companyId=$C"; py 'v=d if isinstance(d,list) else d.get("data",d.get("items",[]));print(len(v))'; }
# (to today: a Storno is dated the day it is made)
datev() { curl -sS -o /tmp/t456.csv -H "x-user-id: $U" -H "x-company-id: $C" \
  "$API/api/v1/reports/datev-export?companyId=$C&startDate=2026-07-01&endDate=$(date +%F)"; }

note "=== more than the credit ==="
N0=$(vouchers)
AS POST "/api/v1/customers/$K/credit-payout?companyId=$C" '{"amount":40,"paymentDate":"2026-07-10","bankAccountId":"'$BANK'"}'
assert_eq "refused" "$STATUS" "400"
assert_eq "…and no voucher posted (was: its bank voucher stayed)" "$(vouchers)" "$N0"

note "=== the 31 € paid out ==="
AS POST "/api/v1/customers/$K/credit-payout?companyId=$C" '{"amount":31,"paymentDate":"2026-07-10","bankAccountId":"'$BANK'"}'
assert_eq "paid out" "$STATUS" "201"
V=$(json_field "$BODY" voucherId)
AS GET "/api/v1/accounting/vouchers/$V?companyId=$C"
assert_eq "the voucher: Forderungen Soll, Bank Haben (was Bank Soll)" \
  "$(py 'print(sorted((l["account"]["accountNumber"], float(l["debit"]), float(l["credit"])) for l in d["lines"]))')" \
  "[('1200', 0.0, 31.0), ('1400', 31.0, 0.0)]"
datev
DEB=$(datev_rows /tmp/t456.csv | awk -F'\t' '$1 ~ /^INV-/ && $2 == "" {print $3}')
assert_eq "DATEV: the bank at 150 − 31 = 119 (was 181)" "$(datev_balance /tmp/t456.csv 1200)" "119.00"
assert_eq "…the customer's Debitor settled (was −31)" "$(datev_balance /tmp/t456.csv "$DEB")" "0.00"
assert_eq "…nothing on the collective account 1400 (was H 31)" "$(datev_balance /tmp/t456.csv 1400)" "0.00"

note "=== its Storno ==="
AS POST "/api/v1/accounting/vouchers/$V/reversal?companyId=$C" '{"reason":"falsch"}'
assert_eq "Storno" "$STATUS" "201"
datev
assert_eq "DATEV: the bank back at 150" "$(datev_balance /tmp/t456.csv 1200)" "150.00"
assert_eq "…the Debitor back at −31" "$(datev_balance /tmp/t456.csv "$DEB")" "-31.00"
AS GET "/api/v1/customers/$K/credit-balance?companyId=$C"
assert_eq "…and the credit back at 31 € (was 0: the ledger kept the payout)" "$(json_field "$BODY" balance)" "31"

summary
