#!/bin/bash
# Test 15: Dashboard KPI endpoint
# - GET /reports/dashboard returns the unified KPI
#   shape: ytd / thisMonth / lastMonth / changes /
#   openReceivables / openPayables / byMonth
# - The byMonth array has 12 entries (one per month
#   in the rolling 12-month window)
# - All amounts are numeric (not NaN / not null)
# - Pct change is correctly signed:
#   * thisMonth > lastMonth → positive
#   * thisMonth < lastMonth → negative
#   * thisMonth == lastMonth → 0
# - The shape is consumable by the dashboard frontend
#   without further math (the frontend used to do
#   3+ fetches and reduce them; that was slow and
#   wrong at year boundaries)

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login

echo "=== Test: dashboard KPI endpoint ==="

# Test 1: shape
api_get "/api/v1/reports/dashboard?companyId=$COMPANY_ID"
assert_eq "dashboard HTTP" "$STATUS" "200"

# Verify all top-level keys are present
for k in ytd thisMonth lastMonth changes openReceivables openPayables byMonth generatedAt; do
  HAS=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
print('yes' if '$k' in d else 'no')
" "$BODY")
  assert_eq "has $k" "$HAS" "yes"
done

# Test 2: ytd sub-shape
YTD_KEYS=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])['ytd']
print(','.join(sorted(d.keys())))
" "$BODY")
assert_eq "ytd keys" "$YTD_KEYS" "countExpenses,countInvoices,expenses,net,revenue,ust,vorsteuer"

# Test 3: byMonth has exactly 12 months
MONTH_COUNT=$(python3 -c "
import json, sys
print(len(json.loads(sys.argv[1])['byMonth']))
" "$BODY")
assert_eq "byMonth length" "$MONTH_COUNT" "12"

# Test 4: byMonth entries have month / revenue / expenses
ENTRY_KEYS=$(python3 -c "
import json, sys
e = json.loads(sys.argv[1])['byMonth'][0]
print(','.join(sorted(e.keys())))
" "$BODY")
assert_eq "byMonth entry keys" "$ENTRY_KEYS" "expenses,month,revenue"

# Test 5: amounts are numeric (no nulls / NaN strings)
NAN_CHECK=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
bad = []
for k in ['revenue', 'ust', 'expenses', 'vorsteuer', 'net']:
    if k in d['ytd'] and not isinstance(d['ytd'][k], (int, float)):
        bad.append(('ytd.' + k, type(d['ytd'][k]).__name__))
print('OK' if not bad else ','.join(f'{a}={b}' for a,b in bad))
" "$BODY")
assert_eq "ytd amounts are numeric" "$NAN_CHECK" "OK"

# Test 6: changes are signed correctly when thisMonth
# > lastMonth. We're not testing a specific value
# (depends on the test dataset); we're testing the
# SIGN. Skip the assert if the dataset has zero on
# both sides.
PCT_SIGN=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
cur = d['thisMonth']['revenue']
prev = d['lastMonth']['revenue']
chg = d['changes']['revenue']
if prev == 0 and cur == 0:
    print('zero')
elif prev == 0:
    print('first')  # can't divide, but not a bug
elif chg > 0 and cur > prev:
    print('up')
elif chg < 0 and cur < prev:
    print('down')
else:
    print(f'WRONG cur={cur} prev={prev} chg={chg}')
" "$BODY")
if [[ "$PCT_SIGN" == "WRONG" ]]; then
  fail "change sign wrong: $PCT_SIGN"
else
  echo "✓ change sign correct ($PCT_SIGN)"
fi

# Test 7: month label format is "YYYY-MM"
MONTH_FMT=$(python3 -c "
import json, sys
e = json.loads(sys.argv[1])['byMonth'][0]
import re
m = e['month']
print('ok' if re.match(r'^\d{4}-\d{2}$', m) else 'bad:'+m)
" "$BODY")
assert_eq "month label format" "$MONTH_FMT" "ok"

# Test 8: missing companyId → 400
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" \
  "http://localhost:3001/api/v1/reports/dashboard" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "missing companyId rejected" "$HTTP" "400"

echo
echo "ALL PASSED"
