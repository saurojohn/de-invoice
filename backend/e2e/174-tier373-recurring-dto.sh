#!/bin/bash
# Tier 373 — recurring-invoice bodies are validated, and every real caller
# still works
#
# The recurring routes typed their bodies as TypeScript intersections, which
# Nest's ValidationPipe cannot validate, so nothing was checked: an item
# vatRate of 19 would reach the same Decimal(5,4) column that overflowed on
# invoices before Tier 372. (Not measured on the recurring route before the
# change, so not claimed as a 500 here.)
#
# The risk of adding a DTO is the global `forbidNonWhitelisted`: any field a
# caller sends that the DTO does not declare becomes a 400. So section 1
# replays the exact shapes the real callers send — the recurring page's create,
# edit, pause, un-pause and clone, and the e2e specs' create with `companyId` in
# the body and an item without `unit` — and requires them to keep succeeding.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login

MUELLER="b9799545-956b-40db-8fcd-769b2d429aa9"
START="$(date +%Y-%m-%d)"
BASE="/api/v1/recurring-invoices"
ITEM='{"description":"e2e-174","productNumber":null,"quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19}'
CREATED=()

note "=== 1. every real caller shape still succeeds ==="
# frontend recurring page, create (page.tsx save())
api_post "$BASE?companyId=$COMPANY_ID" "{\"createdById\":\"$USER_ID\",\"name\":\"e2e-174 page create\",\"customerId\":\"$MUELLER\",\"interval\":\"monthly\",\"intervalCount\":1,\"dayOfMonth\":15,\"startDate\":\"$START\",\"endDate\":null,\"invoiceStatus\":\"draft\",\"sendEmail\":false,\"items\":[$ITEM]}"
assert_status 201 "page create (createdById, endDate null, sendEmail)"
TPL=$(json_field "$BODY" id); CREATED+=("$TPL")

# e2e specs 35 / 90: companyId and notes in the body
api_post "$BASE?companyId=$COMPANY_ID" "{\"companyId\":\"$COMPANY_ID\",\"name\":\"e2e-174 spec create\",\"customerId\":\"$MUELLER\",\"interval\":\"quarterly\",\"startDate\":\"$START\",\"notes\":\"n\",\"items\":[$ITEM]}"
assert_status 201 "spec-style create with companyId + notes in the body"
CREATED+=("$(json_field "$BODY" id)")

# e2e spec 153: item without unit, currency USD
api_post "$BASE?companyId=$COMPANY_ID" "{\"name\":\"e2e-174 usd\",\"customerId\":\"$MUELLER\",\"interval\":\"monthly\",\"startDate\":\"$START\",\"currency\":\"USD\",\"sendEmail\":false,\"items\":[{\"description\":\"no unit\",\"quantity\":1,\"unitPrice\":100,\"vatRate\":0.19}]}"
assert_status 201 "create with currency USD and an item without unit"
CREATED+=("$(json_field "$BODY" id)")

# frontend edit (openEdit normalises items; createdById is sent on update too)
api_put "$BASE/$TPL?companyId=$COMPANY_ID" "{\"createdById\":\"$USER_ID\",\"name\":\"e2e-174 page edited\",\"customerId\":\"$MUELLER\",\"interval\":\"monthly\",\"intervalCount\":1,\"dayOfMonth\":1,\"startDate\":\"$START\",\"endDate\":null,\"invoiceStatus\":\"sent\",\"sendEmail\":true,\"items\":[$ITEM]}"
assert_status 200 "page edit/save"

# frontend pause (full ISO timestamp) and un-pause (null)
api_put "$BASE/$TPL?companyId=$COMPANY_ID" "{\"isActive\":false,\"pausedUntil\":\"2099-01-01T00:00:00.000Z\"}"
assert_status 200 "pause with pausedUntil timestamp"
api_put "$BASE/$TPL?companyId=$COMPANY_ID" '{"isActive":true,"pausedUntil":null}'
assert_status 200 "un-pause with pausedUntil null"

# e2e spec 35: partial updates
api_put "$BASE/$TPL?companyId=$COMPANY_ID" '{"sendEmail":false}'
assert_status 200 "partial update: sendEmail only"

# frontend clone modal
api_post "$BASE/$TPL/clone?companyId=$COMPANY_ID" "{\"name\":\"e2e-174 clone\",\"customerId\":\"$MUELLER\",\"startDate\":\"$START\"}"
assert_status 201 "clone"
CREATED+=("$(json_field "$BODY" id)")

note "=== 2. invalid bodies are 400 ==="
api_post "$BASE?companyId=$COMPANY_ID" "{\"name\":\"x\",\"customerId\":\"$MUELLER\",\"interval\":\"monthly\",\"startDate\":\"$START\",\"items\":[{\"description\":\"x\",\"quantity\":1,\"unitPrice\":100,\"vatRate\":19}]}"
assert_status 400 "item vatRate 19 (a percentage, not a fraction)"
api_post "$BASE?companyId=$COMPANY_ID" "{\"name\":\"x\",\"customerId\":\"$MUELLER\",\"interval\":\"monthly\",\"startDate\":\"$START\",\"items\":[$ITEM],\"bogusField\":1}"
assert_status 400 "undeclared field (whitelist now applies)"
api_post "$BASE?companyId=$COMPANY_ID" "{\"name\":\"x\",\"customerId\":\"$MUELLER\",\"interval\":\"monthly\",\"startDate\":\"${START}T00:00:00.000Z\",\"items\":[$ITEM]}"
assert_status 400 "startDate as a full timestamp (normalizeDates would make it an Invalid Date)"
api_post "$BASE?companyId=$COMPANY_ID" "{\"name\":\"x\",\"customerId\":\"$MUELLER\",\"interval\":\"monthly\",\"intervalCount\":0,\"startDate\":\"$START\",\"items\":[$ITEM]}"
assert_status 400 "intervalCount 0"
api_put "$BASE/$TPL?companyId=$COMPANY_ID" '{"dayOfMonth":40}'
assert_status 400 "update with dayOfMonth 40"

note "=== 3. cleanup ==="
for id in "${CREATED[@]}"; do
  [[ -n "$id" ]] && api_delete "$BASE/$id?companyId=$COMPANY_ID" >/dev/null
done
pass "removed ${#CREATED[@]} e2e-174 templates"

summary
