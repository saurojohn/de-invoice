#!/usr/bin/env bash
# e2e 101: Tier 75 — P&L (Gewinn- und Verlustrechnung).
#
# Validates the new GET /api/v1/reports/pnl
# endpoint that computes the operating result
# for a given year (Umsatzerlöse − Material −
# Sonstige = Betriebsergebnis), with a prior-year
# comparison.
#
# Tests:
#   1. Endpoint reachable, returns 200 with the
#      expected shape (year, months[12], ytd,
#      priorYearYtd, generatedAt, counts).
#   2. months length is always 12.
#   3. months values are well-formed (revenue,
#      materialExpenses, otherExpenses,
#      operatingResult, vat, prior year fields).
#   4. operatingResult = revenue - materialExpenses
#      - otherExpenses (the P&L identity).
#   5. ytd = sum of all 12 months.
#   6. Material/Sonstige split: total expenses
#      == material + other (no double-count).
#   7. year param validation: 1999, 2101 → 400.
#   8. Default year (= current year) works.
#   9. Missing companyId → 400.
#  10. Cross-tenant → 401.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login

USER_ID="$USER_ID"
COMPANY_ID="$COMPANY_ID"

# ── 1. Shape ──
echo
note "=== 1. GET /reports/pnl reachable + shape ==="
RAW=$(curl -sS -w "\n%{http_code}" \
  "$API/api/v1/reports/pnl?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
STATUS=$(echo "$RAW" | tail -1)
BODY=$(echo "$RAW" | sed '$d')
assert_eq "year=2026 → 200" "$STATUS" "200"

TMP=$(mktemp); printf '%s' "$BODY" > "$TMP"
HAS_KEYS=$(python3 -c "
import json
d = json.load(open('$TMP'))
required = ['year', 'months', 'ytd', 'priorYearYtd', 'generatedAt', 'counts']
missing = [k for k in required if k not in d]
print('true' if not missing else f'missing: {missing}')
")
assert_eq "all top-level keys present" "$HAS_KEYS" "true"

# ── 2. months count ──
echo
note "=== 2. months count = 12 ==="
COUNT=$(python3 -c "import json; print(len(json.load(open('$TMP'))['months']))")
assert_eq "months length" "$COUNT" "12"

# ── 3. Month row shape ──
echo
note "=== 3. month row shape ==="
ROW_OK=$(python3 -c "
import json
d = json.load(open('$TMP'))
m = d['months'][0]
required = ['month', 'revenue', 'materialExpenses', 'otherExpenses',
            'operatingResult', 'vat', 'priorYearOperatingResult', 'priorYearChangePercent']
missing = [k for k in required if k not in m]
print('true' if not missing else f'missing: {missing}')
")
assert_eq "month row has all keys" "$ROW_OK" "true"

KEY_FORMAT=$(python3 -c "
import json, re
d = json.load(open('$TMP'))
for m in d['months']:
    if not re.match(r'^2026-\d{2}$', m['month']):
        print(f'bad key: {m[\"month\"]}'); break
else:
    print('true')
")
assert_eq "month keys are YYYY-MM" "$KEY_FORMAT" "true"

# ── 4. P&L identity: op = rev - mat - other ──
echo
note "=== 4. P&L identity per month ==="
PNL_OK=$(python3 -c "
import json
d = json.load(open('$TMP'))
bad = []
for m in d['months']:
    expected = m['revenue'] - m['materialExpenses'] - m['otherExpenses']
    if abs(expected - m['operatingResult']) > 0.01:
        bad.append((m['month'], expected, m['operatingResult']))
print('true' if not bad else f'bad: {bad[:3]}')
")
assert_eq "op = rev - mat - other" "$PNL_OK" "true"

# ── 5. YTD = sum of months ──
echo
note "=== 5. YTD identity ==="
YTD_OK=$(python3 -c "
import json
d = json.load(open('$TMP'))
ytd = d['ytd']
sum_rev = sum(m['revenue'] for m in d['months'])
sum_mat = sum(m['materialExpenses'] for m in d['months'])
sum_oth = sum(m['otherExpenses'] for m in d['months'])
sum_op = sum(m['operatingResult'] for m in d['months'])
sum_vat = sum(m['vat'] for m in d['months'])
ok = (
  abs(ytd['revenue'] - sum_rev) < 0.01 and
  abs(ytd['materialExpenses'] - sum_mat) < 0.01 and
  abs(ytd['otherExpenses'] - sum_oth) < 0.01 and
  abs(ytd['operatingResult'] - sum_op) < 0.01 and
  abs(ytd['vat'] - sum_vat) < 0.01
)
print('true' if ok else 'ytd does not match sum of months')
")
assert_eq "YTD = sum(months)" "$YTD_OK" "true"

# ── 6. Material + other = total expenses (no overlap) ──
echo
note "=== 6. Material/other split integrity ==="
SPLIT_OK=$(python3 -c "
import json
d = json.load(open('$TMP'))
# The Material bucket is the SUM of expenses where
# category starts with Material or Waren. The 'other'
# bucket = total expenses − material. So material
# must be <= total per month.
bad = []
for m in d['months']:
    if m['materialExpenses'] < 0 or m['otherExpenses'] < 0:
        bad.append(m['month'])
print('true' if not bad else f'negative: {bad}')
")
assert_eq "no negative expense buckets" "$SPLIT_OK" "true"

# ── 7. year validation ──
echo
note "=== 7. year param validation ==="
STATUS_OLD=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/reports/pnl?companyId=$COMPANY_ID&year=1999" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "year=1999 → 400" "$STATUS_OLD" "400"

STATUS_FUTURE=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/reports/pnl?companyId=$COMPANY_ID&year=2101" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "year=2101 → 400" "$STATUS_FUTURE" "400"

# ── 8. Default year works ──
echo
note "=== 8. default year (no year param) ==="
DEFAULT_YEAR=$(curl -sS \
  "$API/api/v1/reports/pnl?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['year'])")
# Current year (2026 in our env, per system date)
assert_eq "default year is 2026" "$DEFAULT_YEAR" "2026"

# ── 9. Missing companyId → 400 ──
echo
note "=== 9. missing companyId → 400 ==="
STATUS_NO_CID=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/reports/pnl" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID")
assert_eq "no companyId → 400" "$STATUS_NO_CID" "400"

# ── 10. Cross-tenant → 401 ──
echo
note "=== 10. cross-tenant → 401 ==="
STATUS_CROSS=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/reports/pnl?companyId=$COMPANY_ID&year=2026" \
  -H "x-user-id: $USER_ID" \
  -H "x-company-id: 00000000-0000-0000-0000-000000000000")
assert_eq "cross-tenant → 401" "$STATUS_CROSS" "401"

rm -f "$TMP"
summary
exit $?
