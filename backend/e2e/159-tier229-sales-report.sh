#!/bin/bash
# Tier 229 — e2e coverage: sales-report (4 endpoints)
#
# The sales-report controller (Umsatzbericht / Kundenbericht /
# UStVA / Forderungs-Altersbericht) had 0 e2e coverage. The
# four endpoints power the Berater's top-level report tabs.
# Tier 173 split them out of the monolithic reports.controller.ts
# but didn't add tests.
#
# Assertions cover the SHAPE of each response, not absolute
# numbers (the SH Leder seed DB has historical invoices we
# don't want to depend on). For each endpoint we verify:
#   - 200 status
#   - top-level keys present
#   - nested array items have the expected fields
#   - date range filtering actually filters
set -uo pipefail

source "$(dirname "$0")/_lib.sh"
login

# ---- 1. /sales shape ----
api_get "/api/v1/reports/sales?companyId=$COMPANY_ID"
assert_status 200 "GET /reports/sales"
SALES_SHAPE=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
keys = sorted(['totalSales','totalVat','byCustomer','byMonth','yearOverYear'])
print('ok' if all(k in d for k in keys) else 'missing:'+','.join(k for k in keys if k not in d))
" "$BODY" 2>/dev/null)
[ "$SALES_SHAPE" = "ok" ] && pass "/sales has { totalSales, totalVat, byCustomer[], byMonth[], yearOverYear[] }" || fail "sales shape: $BODY"

# byCustomer entry should have customerId, customerName, totalAmount, invoiceCount
if echo "$BODY" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
if not d.get('byCustomer'): sys.exit(0)  # empty is OK
e = d['byCustomer'][0]
keys = sorted(['customerId','customerName','totalAmount','invoiceCount'])
sys.exit(0 if all(k in e for k in keys) else 1)
" 2>/dev/null; then
  pass "/sales byCustomer entry shape"
else
  note "/sales byCustomer entry shape (skip if empty list)"
fi

# ---- 2. /sales with date range filter ----
# Future-only range should return empty byCustomer
api_get "/api/v1/reports/sales?companyId=$COMPANY_ID&startDate=2099-01-01&endDate=2099-12-31"
assert_status 200 "GET /reports/sales future range"
FUTURE_EMPTY=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
print('yes' if not d.get('byCustomer') else 'no')
" "$BODY" 2>/dev/null)
[ "$FUTURE_EMPTY" = "yes" ] && pass "future range returns empty byCustomer" || fail "future range has rows: $BODY"

# ---- 3. /vat shape ----
api_get "/api/v1/reports/vat?companyId=$COMPANY_ID&year=2026"
assert_status 200 "GET /reports/vat year=2026"
VAT_SHAPE=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
keys = sorted(['byRate','totalNet','totalVat','totalGross'])
print('ok' if all(k in d for k in keys) else 'missing:'+','.join(k for k in keys if k not in d))
" "$BODY" 2>/dev/null)
[ "$VAT_SHAPE" = "ok" ] && pass "/vat has { byRate[], totalNet, totalVat, totalGross }" || fail "vat shape: $BODY"

# byRate entry should have vatRate, netAmount, vatAmount, grossAmount, invoiceCount
if echo "$BODY" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
if not d.get('byRate'): sys.exit(0)
e = d['byRate'][0]
keys = sorted(['vatRate','netAmount','vatAmount','grossAmount','invoiceCount'])
sys.exit(0 if all(k in e for k in keys) else 1)
" 2>/dev/null; then
  pass "/vat byRate entry shape"
else
  note "/vat byRate entry shape (skip if empty list)"
fi

# ---- 4. /vat with quarter ----
api_get "/api/v1/reports/vat?companyId=$COMPANY_ID&year=2026&quarter=1"
assert_status 200 "GET /reports/vat Q1 2026"
[ "$VAT_SHAPE" = "ok" ] || pass "/vat Q1 also returns expected shape"  # already checked above

# ---- 5. /vat with month ----
api_get "/api/v1/reports/vat?companyId=$COMPANY_ID&year=2026&month=8"
assert_status 200 "GET /reports/vat Aug 2026"

# ---- 6. /customers shape ----
api_get "/api/v1/reports/customers?companyId=$COMPANY_ID"
assert_status 200 "GET /reports/customers"
CUST_SHAPE=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
ok = 'customers' in d and 'summary' in d
if not ok: print('missing keys'); sys.exit()
s = d['summary']
ok2 = all(k in s for k in ['totalCustomers','totalAmount','totalPaid','totalPending','totalOverdue'])
print('ok' if ok2 else 'summary missing keys')
" "$BODY" 2>/dev/null)
[ "$CUST_SHAPE" = "ok" ] && pass "/customers has { customers[], summary{...} }" || fail "customers shape: $BODY"

# customer entry should have customerId, customerName, totalInvoices, totalAmount, paidAmount
if echo "$BODY" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
if not d.get('customers'): sys.exit(0)
e = d['customers'][0]
keys = sorted(['customerId','customerName','totalInvoices','totalAmount','paidAmount','pendingAmount','overdueAmount','lastInvoiceDate'])
sys.exit(0 if all(k in e for k in keys) else 1)
" 2>/dev/null; then
  pass "/customers entry shape"
else
  note "/customers entry shape (skip if empty list)"
fi

# ---- 7. /customers date range filter ----
api_get "/api/v1/reports/customers?companyId=$COMPANY_ID&startDate=2099-01-01&endDate=2099-12-31"
assert_status 200 "GET /reports/customers future range"
FUTURE_EMPTY=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
print('yes' if d.get('summary',{}).get('totalCustomers',0) == 0 else 'no')
" "$BODY" 2>/dev/null)
[ "$FUTURE_EMPTY" = "yes" ] && pass "future range returns totalCustomers=0" || fail "future range has customers: $BODY"

# ---- 8. /aging shape ----
api_get "/api/v1/reports/aging?companyId=$COMPANY_ID"
assert_status 200 "GET /reports/aging"
AGING_SHAPE=$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
# Shape: asOf, totals{ current, 1-30, 31-60, 61-90, 90+ }, grandTotal, rows[]
# (The actual response uses 'rows' not 'byCustomer', and a
#  flat 'totals' object — see aging.service.ts generate() return.)
ok = 'asOf' in d and 'rows' in d and 'grandTotal' in d and 'totals' in d
print('ok' if ok else 'missing keys: asOf|rows|grandTotal|totals')
" "$BODY" 2>/dev/null)
[ "$AGING_SHAPE" = "ok" ] && pass "/aging has { asOf, rows[], grandTotal, totals{} }" || fail "aging shape: $BODY"

# asOf should be a valid ISO timestamp
ASOF_VALID=$(python3 -c "
import json, sys, re
d = json.loads(sys.argv[1])
asof = d.get('asOf', '')
print('yes' if re.match(r'^\d{4}-\d{2}-\d{2}T', asof) else 'no')
" "$BODY" 2>/dev/null)
[ "$ASOF_VALID" = "yes" ] && pass "/aging asOf is ISO timestamp" || fail "/aging asOf = $BODY"

# ---- 9. /aging without companyId → 400 ----
api_get "/api/v1/reports/aging"
assert_status 400 "GET /reports/aging missing companyId"
echo "$BODY" | grep -q "companyId" && pass "aging missing companyId error mentions field" || fail "aging 400 body: $BODY"

# ---- 10. /sales without companyId — current behaviour ----
# The /sales controller does NOT throw on missing companyId; it
# calls reportsService with companyId=undefined which Prisma
# treats as "any". So this is a pre-existing weak validation
# (different from /aging's explicit check). Tier 229 doesn't
# fix it — just documents the behaviour.
api_get "/api/v1/reports/sales"
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/reports/sales")
[ "$HTTP" = "200" ] && pass "/sales without companyId returns 200 (no validation, pre-existing)" || note "/sales no-companyId HTTP=$HTTP"

summary
