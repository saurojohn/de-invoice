#!/bin/bash
# e2e/52-customer-statement.sh — Tier 20
#
# Verifies the GET /api/v1/customers/:id/statement endpoint
# correctness: opening/closing balance math, line ordering,
# payment/credit sign handling, total invariants.
#
# Strategy:
#   1. Create a fresh test customer (isolated from the
#      Müller GmbH test data so the test is deterministic).
#   2. Create 2 invoices (different dates) + 1 credit + 2
#      payments, all within a known date range.
#   3. Request the statement over that range.
#   4. Assert opening + closing + per-line balance + totals.
#
# Cleans up after itself so the test is repeatable.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login

FAILS=0
TEST_TAG="tier20-statement-$$"
TEST_EMAIL="${TEST_TAG}@example.com"

# ── Setup: create test customer ──────────────────────────
note "Creating test customer..."
api_post "/api/v1/customers?companyId=$COMPANY_ID" '{
  "type": "business",
  "name": "Tier20 Statement Test Co",
  "address": {"street":"Teststr 1","city":"Berlin","postalCode":"10115","country":"DE"},
  "contact": {"email":"'$TEST_EMAIL'"},
  "paymentTerms": 30
}'
[[ "$STATUS" == "201" ]] || { fail "create customer failed (status=$STATUS): $BODY"; exit 1; }
CUSTOMER_ID=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
pass "customer created: $CUSTOMER_ID"

# Cleanup on exit (trap so we don't leak test data even on assertion failure)
cleanup() {
  local cid="$CUSTOMER_ID"
  if [[ -n "$cid" ]]; then
    docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
      "DELETE FROM \"Payment\" WHERE \"invoiceId\" IN (SELECT id FROM \"Invoice\" WHERE \"customerId\"='$cid');" >/dev/null 2>&1 || true
    docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
      "DELETE FROM \"Invoice\" WHERE \"customerId\"='$cid';" >/dev/null 2>&1 || true
    docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
      "DELETE FROM \"Customer\" WHERE id='$cid';" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ── Setup: create 2 invoices + 1 credit + 2 payments ─────
# Invoice 1: 2026-03-15, 119.00 EUR (100 net + 19 VAT)
api_post "/api/v1/invoices?companyId=$COMPANY_ID" '{
  "customerId": "'$CUSTOMER_ID'",
  "issueDate": "2026-03-15T00:00:00.000Z",
  "dueDate":   "2026-04-14T00:00:00.000Z",
  "type": "INV",
  "items": [{
    "description": "Testartikel A",
    "quantity": 1,
    "unitPrice": 100.00,
    "vatRate": 0.19
  }]
}'
[[ "$STATUS" == "201" ]] || { fail "create invoice 1 failed (status=$STATUS): $BODY"; exit 1; }
INV1_ID=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
INV1_TOTAL=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['total'])")
pass "invoice 1 created: € $INV1_TOTAL (2026-03-15)"

# Invoice 2: 2026-04-20, 238.00 EUR (200 net + 38 VAT)
api_post "/api/v1/invoices?companyId=$COMPANY_ID" '{
  "customerId": "'$CUSTOMER_ID'",
  "issueDate": "2026-04-20T00:00:00.000Z",
  "dueDate":   "2026-05-20T00:00:00.000Z",
  "type": "INV",
  "items": [{
    "description": "Testartikel B",
    "quantity": 2,
    "unitPrice": 100.00,
    "vatRate": 0.19
  }]
}'
[[ "$STATUS" == "201" ]] || { fail "create invoice 2 failed (status=$STATUS): $BODY"; exit 1; }
INV2_ID=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
INV2_TOTAL=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['total'])")
pass "invoice 2 created: € $INV2_TOTAL (2026-04-20)"

# Credit note: 2026-05-10, 50.00 EUR (42.0168 net + 7.9832 VAT)
api_post "/api/v1/invoices?companyId=$COMPANY_ID" '{
  "customerId": "'$CUSTOMER_ID'",
  "issueDate": "2026-05-10T00:00:00.000Z",
  "type": "CN",
  "items": [{
    "description": "Gutschrift",
    "quantity": 1,
    "unitPrice": 42.0168,
    "vatRate": 0.19
  }]
}'
[[ "$STATUS" == "201" ]] || { fail "create credit note failed (status=$STATUS): $BODY"; exit 1; }
CN_ID=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
pass "credit note created (2026-05-10)"

# Payment 1: 2026-04-01, € 119.00 (full payment of INV1)
api_post "/api/v1/invoices/$INV1_ID/payments?companyId=$COMPANY_ID" '{
  "amount": 119.00,
  "paymentDate": "2026-04-01T00:00:00.000Z",
  "paymentMethod": "bank_transfer",
  "reference": "TEST-PAY-1"
}'
[[ "$STATUS" == "201" ]] || { fail "create payment 1 failed (status=$STATUS): $BODY"; exit 1; }
pass "payment 1 created: € 119.00 (2026-04-01)"

# Payment 2: 2026-05-15, € 100.00 (partial payment of INV2)
api_post "/api/v1/invoices/$INV2_ID/payments?companyId=$COMPANY_ID" '{
  "amount": 100.00,
  "paymentDate": "2026-05-15T00:00:00.000Z",
  "paymentMethod": "bank_transfer",
  "reference": "TEST-PAY-2"
}'
[[ "$STATUS" == "201" ]] || { fail "create payment 2 failed (status=$STATUS): $BODY"; exit 1; }
pass "payment 2 created: € 100.00 (2026-05-15)"

# Flip draft invoices to 'sent' so they appear on the statement
# (statement service excludes drafts — the user hasn't been
# notified about them yet, so they don't belong on a customer-facing
# Kontoauszug).
api_put "/api/v1/invoices/$INV2_ID/status?companyId=$COMPANY_ID" '{"status":"sent"}'
[[ "$STATUS" == "200" ]] || { fail "set INV2 status failed (status=$STATUS): $BODY"; exit 1; }
api_put "/api/v1/invoices/$CN_ID/status?companyId=$COMPANY_ID" '{"status":"sent"}'
[[ "$STATUS" == "200" ]] || { fail "set CN status failed (status=$STATUS): $BODY"; exit 1; }
pass "invoices flipped to 'sent'"

# ── Test: full-period statement (Mar 1 – Jun 30) ──────────
note "Requesting statement for 2026-03-01..2026-06-30..."

api_get "/api/v1/customers/$CUSTOMER_ID/statement?companyId=$COMPANY_ID&from=2026-03-01&to=2026-06-30"
[[ "$STATUS" == "200" ]] || { fail "statement request failed (status=$STATUS): $BODY"; exit 1; }
STMT_FILE=$(mktemp)
echo "$BODY" > "$STMT_FILE"

# Helper to extract a JSON field. Prisma returns Decimal columns
# as either int (for whole values) or float (for fractional).
# Both serialize differently in JSON — we normalize to a clean
# "119" or "119.0" string for easy assert_eq comparison.
jget() { python3 -c "
import sys, json
d = json.load(open('$STMT_FILE'))
v = d$1
if isinstance(v, (int, float)):
    # Print whole numbers as '119', fractional as '119.5'
    if float(v).is_integer():
        print(int(v))
    else:
        print(v)
else:
    print(v)
"; }

# ── Assertion 1: opening balance = 0 (no invoices before 2026-03-01)
OPENING=$(jget "['openingBalance']")
assert_eq "opening balance is 0" "$OPENING" "0"

# ── Assertion 2: closing balance = 119 + 238 - 50 - 119 - 100 = 88
# (INV1=+119, INV2=+238, CN=-50, PAY1=-119, PAY2=-100)
CLOSING=$(jget "['closingBalance']")
assert_eq "closing balance = 88" "$CLOSING" "88"

# ── Assertion 3: 5 lines total
LINES_LEN=$(jget "['lines'].__len__()")
assert_eq "5 line items" "$LINES_LEN" "5"

# ── Assertion 4: lines sorted by date DESCENDING (newest first, default)
SORTED=$(python3 -c "
import json
d = json.load(open('$STMT_FILE'))
dates = [l['date'] for l in d['lines']]
print('YES' if dates == sorted(dates, reverse=True) else 'NO')
")
assert_eq "lines sorted by date DESC (newest first)" "$SORTED" "YES"

# ── Assertion 5: FIRST line under DESC = newest = PAY2 (2026-05-15, -100)
# Under the old ASC order this was INV1; with DESC the
# newest activity is on top. PAY2's historical balance
# (= opening + all amounts up to and including PAY2 = 88)
# is the closing balance.
LINE1_TYPE=$(jget "['lines'][0]['type']")
LINE1_AMT=$(jget "['lines'][0]['amount']")
LINE1_BAL=$(jget "['lines'][0]['balance']")
assert_eq "line 1 (newest) type=payment" "$LINE1_TYPE" "payment"
assert_eq "line 1 (newest) amount=-100" "$LINE1_AMT" "-100"
assert_eq "line 1 (newest) balance=88 (closingBalance)" "$LINE1_BAL" "88"

# ── Assertion 6: LAST line under DESC = oldest = INV1 (2026-03-15, +119)
# Its balance is the historical balance right after INV1
# was posted: opening(0) + 119 = 119.
LINE_LAST_TYPE=$(jget "['lines'][-1]['type']")
LINE_LAST_AMT=$(jget "['lines'][-1]['amount']")
LINE_LAST_BAL=$(python3 -c "
import json
d = json.load(open('$STMT_FILE'))
v = d['lines'][-1]['balance']
print(int(v) if float(v).is_integer() else v)
")
assert_eq "last line (oldest) type=invoice" "$LINE_LAST_TYPE" "invoice"
assert_eq "last line (oldest) amount=119" "$LINE_LAST_AMT" "119"
assert_eq "last line (oldest) balance=119 (after INV1)" "$LINE_LAST_BAL" "119"

# ── Assertion 7: credit note has negative amount
CN_LINE=$(python3 -c "
import json
d = json.load(open('$STMT_FILE'))
for l in d['lines']:
    if l['type'] == 'credit':
        print(f\"{l['amount']}|{l['type']}\")
        break
")
if echo "$CN_LINE" | grep -qE '^\-'; then
  pass "credit note is negative amount"
else
  fail "credit note should be negative: $CN_LINE"
fi

# ── Assertion 8: payment lines have negative amount
PAY_LINES=$(python3 -c "
import json
d = json.load(open('$STMT_FILE'))
neg = sum(1 for l in d['lines'] if l['type'] == 'payment' and l['amount'] < 0)
print(neg)
")
assert_eq "all payment lines are negative" "$PAY_LINES" "2"

# ── Assertion 9: opening + sum(amounts) === closing (invariant)
INVARIANT=$(python3 -c "
import json
d = json.load(open('$STMT_FILE'))
opening = d['openingBalance']
delta = sum(l['amount'] for l in d['lines'])
closing = d['closingBalance']
print('OK' if abs(opening + delta - closing) < 0.001 else f'FAIL open={opening} delta={delta} close={closing}')
")
assert_eq "balance invariant holds" "$INVARIANT" "OK"

# ── Assertion 10: totals aggregates match lines
TOTALS_OK=$(python3 -c "
import json
d = json.load(open('$STMT_FILE'))
inv_total = sum(l['amount'] for l in d['lines'] if l['type'] == 'invoice')
pay_total = sum(l['amount'] for l in d['lines'] if l['type'] == 'payment')
cred_total = sum(l['amount'] for l in d['lines'] if l['type'] == 'credit')
inv_count = sum(1 for l in d['lines'] if l['type'] == 'invoice')
pay_count = sum(1 for l in d['lines'] if l['type'] == 'payment')
cred_count = sum(1 for l in d['lines'] if l['type'] == 'credit')
t = d['totals']
ok = (abs(t['invoicesAmount'] - inv_total) < 0.001 and
      abs(t['paymentsAmount'] - pay_total) < 0.001 and
      abs(t['creditsAmount'] - cred_total) < 0.001 and
      t['invoicesCount'] == inv_count and
      t['paymentsCount'] == pay_count and
      t['creditsCount'] == cred_count)
print('OK' if ok else 'FAIL')
")
assert_eq "totals aggregates match" "$TOTALS_OK" "OK"

# ── Assertion 11: error on missing from/to
HTTP_400=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/customers/$CUSTOMER_ID/statement?companyId=$COMPANY_ID")
assert_eq "missing from/to returns 400" "$HTTP_400" "400"

# ── Assertion 12: error on from > to
HTTP_400B=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/customers/$CUSTOMER_ID/statement?companyId=$COMPANY_ID&from=2026-06-01&to=2026-05-01")
assert_eq "from > to returns 400" "$HTTP_400B" "400"

# ── Assertion 13: range > 24 months returns 400
HTTP_400C=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/customers/$CUSTOMER_ID/statement?companyId=$COMPANY_ID&from=2020-01-01&to=2026-06-01")
assert_eq "range > 24 months returns 400" "$HTTP_400C" "400"

# ── Assertion 14: cross-tenant customer returns 404
FAKE_CUST="00000000-0000-0000-0000-000000000999"
HTTP_404=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/customers/$FAKE_CUST/statement?companyId=$COMPANY_ID&from=2026-01-01&to=2026-06-30")
assert_eq "nonexistent customer returns 404" "$HTTP_404" "404"

# ── Assertion 15: sub-range (Apr only) shows just INV2 + first payment
api_get "/api/v1/customers/$CUSTOMER_ID/statement?companyId=$COMPANY_ID&from=2026-04-01&to=2026-04-30"
APR_FILE=$(mktemp)
echo "$BODY" > "$APR_FILE"
APR_OPENING=$(python3 -c "import json; d=json.load(open('$APR_FILE')); v=d['openingBalance']; print(int(v) if float(v).is_integer() else v)")
# Opening balance should include INV1 (€119) which was before April.
# No payments before April (PAY1 was April 1, included).
# So opening = +119 (INV1) - 0 (no payments yet) = 119
assert_eq "April-only opening = 119" "$APR_OPENING" "119"
APR_LINES=$(python3 -c "import json; d=json.load(open('$APR_FILE')); print(len(d['lines']))")
# April lines: PAY1 (Apr 1), INV2 (Apr 20) → 2 lines
assert_eq "April-only line count = 2" "$APR_LINES" "2"

rm -f "$STMT_FILE" "$APR_FILE"

# ── Assertion 16: ?order=asc reverses the line order ────
# (opt-in for accountants who want chronological paper-trail order)
api_get "/api/v1/customers/$CUSTOMER_ID/statement?companyId=$COMPANY_ID&from=2026-03-01&to=2026-06-30&order=asc"
ASC_FILE=$(mktemp)
echo "$BODY" > "$ASC_FILE"

# Under ASC: first line should be INV1 (oldest)
ASC_FIRST_TYPE=$(python3 -c "
import json; d = json.load(open('$ASC_FILE'));
v = d['lines'][0]['type']
print(v)
")
assert_eq "order=asc: first line is invoice (oldest)" "$ASC_FIRST_TYPE" "invoice"

# Under ASC: lines should be in ASCENDING date order
ASC_SORTED=$(python3 -c "
import json
d = json.load(open('$ASC_FILE'))
dates = [l['date'] for l in d['lines']]
print('YES' if dates == sorted(dates) else 'NO')
")
assert_eq "order=asc: lines sorted by date ASC" "$ASC_SORTED" "YES"

# Balance under ASC: last line's balance === closing (88)
ASC_LAST_BAL=$(python3 -c "
import json
d = json.load(open('$ASC_FILE'))
v = d['lines'][-1]['balance']
print(int(v) if float(v).is_integer() else v)
")
assert_eq "order=asc: last line balance = closing" "$ASC_LAST_BAL" "88"

# Closing balance is identical regardless of order (it's a property
# of the data, not the display)
ASC_CLOSING=$(python3 -c "
import json
d = json.load(open('$ASC_FILE'))
v = d['closingBalance']
print(int(v) if float(v).is_integer() else v)
")
assert_eq "order=asc: closing balance unchanged" "$ASC_CLOSING" "88"

# ── Assertion 17: ?order=invalid returns 400 ─────────────
HTTP_400D=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/customers/$CUSTOMER_ID/statement?companyId=$COMPANY_ID&from=2026-03-01&to=2026-06-30&order=sideways")
assert_eq "order=sideways returns 400" "$HTTP_400D" "400"

rm -f "$ASC_FILE"

echo ""
echo "==============================="
if [[ $FAILS -eq 0 ]]; then
  echo "52-customer-statement: ALL PASSED ✓"
  exit 0
else
  echo "52-customer-statement: $FAILS FAILURE(S)"
  exit 1
fi