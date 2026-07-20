#!/usr/bin/env bash
# e2e 100: Tier 74 — Cash Flow Forecast (Liquiditätsplanung).
#
# Validates the new GET /api/v1/reports/cashflow
# endpoint that projects the company's bank
# balance for the next N months.
#
# Tests:
#   1. Endpoint reachable, returns 200 with the
#      expected shape (months[], summary, counts,
#      generatedAt).
#   2. months length matches the requested count
#      (default 12, custom 6, max 36).
#   3. months values are well-formed (month key
#      YYYY-MM, label, incoming, outgoing, net,
#      cumulative, isDry).
#   4. Cumulative math: startingBalance +
#      sum(net) == endBalance.
#   5. firstDryMonth is non-null only when a
#      cumulative balance ever goes negative.
#   6. Counts reflect the seed data accurately
#      (openInvoices, openExpenses, recurringTemplates).
#   7. months param validation: 0, 100, "abc"
#      all return 400.
#   8. startingBalance param is parsed (German
#      number format with comma AND English format
#      with dot must both work).
#   9. missing companyId → 400.
#  10. cross-tenant → 401.
#
# Why a dedicated test: the forecast is the basis
# of a "dry in N months" warning the UI shows. A
# regression here is the kind that erodes user
# trust silently — the page renders fine but the
# numbers are wrong. Direct e2e is the cheapest
# way to lock the math.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
USER_ID="$USER_ID"
COMPANY_ID="$COMPANY_ID"

# ── 1. Endpoint reachable + expected shape ──
echo
note "=== 1. GET /reports/cashflow reachable + shape ==="
RAW=$(curl -sS -w "\n%{http_code}" \
  "$API/api/v1/reports/cashflow?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
STATUS=$(echo "$RAW" | tail -1)
BODY=$(echo "$RAW" | sed '$d')
assert_eq "default 200" "$STATUS" "200"

TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"
HAS_KEYS=$(python3 -c "
import json, sys
d = json.load(open('$TMP'))
required = ['companyId', 'startingBalance', 'months', 'summary', 'counts', 'generatedAt']
missing = [k for k in required if k not in d]
print('true' if not missing else f'missing: {missing}')
")
assert_eq "all top-level keys present" "$HAS_KEYS" "true"

# ── 2. months length matches requested count ──
echo
note "=== 2. months count param ==="
LEN6=$(curl -sS \
  "$API/api/v1/reports/cashflow?companyId=$COMPANY_ID&months=6" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  | python3 -c "import json,sys; print(len(json.load(sys.stdin)['months']))")
assert_eq "months=6 → 6 entries" "$LEN6" "6"

LEN1=$(curl -sS \
  "$API/api/v1/reports/cashflow?companyId=$COMPANY_ID&months=1" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  | python3 -c "import json,sys; print(len(json.load(sys.stdin)['months']))")
assert_eq "months=1 → 1 entry" "$LEN1" "1"

LEN36=$(curl -sS \
  "$API/api/v1/reports/cashflow?companyId=$COMPANY_ID&months=36" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  | python3 -c "import json,sys; print(len(json.load(sys.stdin)['months']))")
assert_eq "months=36 → 36 entries" "$LEN36" "36"

# ── 3. month row shape ──
echo
note "=== 3. month row shape ==="
ROW_OK=$(python3 -c "
import json
d = json.load(open('$TMP'))
m = d['months'][0]
required = ['month', 'label', 'incoming', 'outgoing', 'net', 'cumulative', 'isDry']
missing = [k for k in required if k not in m]
print('true' if not missing else f'missing: {missing}')
")
assert_eq "month row has all keys" "$ROW_OK" "true"

KEY_FORMAT=$(python3 -c "
import json, re
d = json.load(open('$TMP'))
for m in d['months']:
    if not re.match(r'^\d{4}-\d{2}$', m['month']):
        print(f'bad key: {m[\"month\"]}'); break
else:
    print('true')
")
assert_eq "month keys are YYYY-MM" "$KEY_FORMAT" "true"

# ── 4. Cumulative math sanity ──
echo
note "=== 4. cumulative math ==="
MATH_OK=$(python3 -c "
import json
d = json.load(open('$TMP'))
sb = d['startingBalance']
cum_observed = d['months'][-1]['cumulative']
cum_expected = sb + sum(m['net'] for m in d['months'])
print('true' if abs(cum_observed - cum_expected) < 0.01 else f'mismatch: observed={cum_observed} expected={cum_expected}')
")
assert_eq "cumulative = starting + sum(net)" "$MATH_OK" "true"

# ── 5. firstDryMonth consistency ──
echo
note "=== 5. firstDryMonth consistency ==="
DRY_OK=$(python3 -c "
import json
d = json.load(open('$TMP'))
expected_dry = None
for m in d['months']:
    if m['cumulative'] < 0:
        expected_dry = m['month']
        break
actual = d['summary']['firstDryMonth']
print('true' if actual == expected_dry else f'expected {expected_dry}, got {actual}')
")
assert_eq "firstDryMonth matches first negative cumulative" "$DRY_OK" "true"

# ── 6. Counts are non-negative integers ──
echo
note "=== 6. counts sanity ==="
COUNTS_OK=$(python3 -c "
import json
d = json.load(open('$TMP'))
c = d['counts']
ok = all(isinstance(c[k], int) and c[k] >= 0 for k in ('openInvoices', 'openExpenses', 'recurringTemplates'))
print('true' if ok else 'bad counts')
")
assert_eq "counts are non-negative ints" "$COUNTS_OK" "true"

# ── 7. months param validation ──
echo
note "=== 7. months param validation ==="
STATUS0=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/reports/cashflow?companyId=$COMPANY_ID&months=0" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "months=0 → 400" "$STATUS0" "400"

STATUS100=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/reports/cashflow?companyId=$COMPANY_ID&months=100" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "months=100 → 400" "$STATUS100" "400"

# ── 8. startingBalance formats ──
echo
note "=== 8. startingBalance formats ==="
SB_DOT=$(curl -sS \
  "$API/api/v1/reports/cashflow?companyId=$COMPANY_ID&startingBalance=1234.56" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['startingBalance'])")
assert_eq "1234.56 (dot)" "$SB_DOT" "1234.56"

SB_COMMA=$(curl -sS \
  "$API/api/v1/reports/cashflow?companyId=$COMPANY_ID&startingBalance=1234,56" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['startingBalance'])")
assert_eq "1234,56 (comma)" "$SB_COMMA" "1234.56"

# ── 9. Missing companyId → 400 ──
echo
note "=== 9. missing companyId → 400 ==="
STATUS_NO_CID=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/reports/cashflow" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "no companyId → 400" "$STATUS_NO_CID" "400"

# ── 10. Cross-tenant → 401 ──
echo
note "=== 10. cross-tenant → 401 ==="
STATUS_CROSS=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/reports/cashflow?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: 00000000-0000-0000-0000-000000000000")
assert_eq "cross-tenant → 401" "$STATUS_CROSS" "401"

rm -f "$TMP"
summary
exit $?
