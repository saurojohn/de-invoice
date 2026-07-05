#!/usr/bin/env bash
# e2e 67: Tier 39 — Cost-Center CRUD on Invoice.
#
# Validates:
#   1. POST /invoices with costCenter + costObject stores
#      both fields (returned in the create response).
#   2. PUT  /invoices/:id updates costCenter + costObject.
#   3. GET  /invoices/cost-centers returns the distinct
#      non-null cost-centers stamped across the company.
#   4. GET  /invoices/cost-centers?costCenter=X returns
#      the paired costObjects when filtered.
#   5. Bad inputs: missing companyId → 400, empty
#      costCenter is coerced to null (NOT stored as "").

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

USER_ID="8c6a9669-0069-4137-a842-a66fd1d178d6"
COMPANY_ID="ad257ec3-d319-479b-b870-3fe76e8f3111"

# Wipe prior Tier 39 fixture rows.
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL
DELETE FROM "Invoice" WHERE "customerId" IN (SELECT id FROM "Customer" WHERE "name" = 'Tier39 CC Customer' AND "companyId" = '$COMPANY_ID');
DELETE FROM "Customer" WHERE "name" = 'Tier39 CC Customer' AND "companyId" = '$COMPANY_ID';
SQL

# ───── Seed customer ─────
CUST_BODY=$(cat <<JSON
{
  "name": "Tier39 CC Customer",
  "type": "business",
  "address": {"street":"cc1","postalCode":"60311","city":"FFM","country":"DE"},
  "contact": {"email":"cc39@x.com","phone":"+49 30"}
}
JSON
)
curl -sS -o /tmp/t39_cust.json -w "%{http_code}" -X POST \
  "$API/api/v1/customers?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d "$CUST_BODY" > /dev/null
CUSTOMER_ID=$(python3 -c "import json; print(json.load(open('/tmp/t39_cust.json'))['id'])")
echo "customer: $CUSTOMER_ID"

# ───── 1. POST invoice WITH costCenter + costObject ─────
echo
echo "=== 1. POST /invoices with costCenter + costObject ==="
INV_BODY=$(cat <<JSON
{
  "customerId": "$CUSTOMER_ID",
  "type": "INV",
  "issueDate": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "costCenter": "VERTRIEB",
  "costObject": "PROJ-2026-Q3",
  "items": [{"description":"x","quantity":1,"unitPrice":100,"vatRate":0.19}]
}
JSON
)
curl -sS -o /tmp/t39_inv1.json -w "%{http_code}" -X POST \
  "$API/api/v1/invoices?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d "$INV_BODY" > /dev/null
INV1_ID=$(python3 -c "import json; print(json.load(open('/tmp/t39_inv1.json'))['id'])")
CC=$(python3 -c "import json; print(json.load(open('/tmp/t39_inv1.json'))['costCenter'] or '')")
CO=$(python3 -c "import json; print(json.load(open('/tmp/t39_inv1.json'))['costObject'] or '')")
assert_eq "create returned costCenter" "$CC" "VERTRIEB"
assert_eq "create returned costObject" "$CO" "PROJ-2026-Q3"
echo "  invoice: $INV1_ID cc=$CC co=$CO"

# ───── 2. PUT update costCenter + costObject ─────
echo
echo "=== 2. PUT /invoices/:id updates costCenter ==="
PUT_STATUS=$(curl -sS -o /tmp/t39_inv2.json -w "%{http_code}" -X PUT \
  "$API/api/v1/invoices/$INV1_ID?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d '{"costCenter":"SERVICE","costObject":"PROJ-2026-Q4"}')
assert_eq "PUT status 200" "$PUT_STATUS" "200"
CC=$(python3 -c "import json; print(json.load(open('/tmp/t39_inv2.json'))['costCenter'] or '')")
CO=$(python3 -c "import json; print(json.load(open('/tmp/t39_inv2.json'))['costObject'] or '')")
assert_eq "PUT applied costCenter" "$CC" "SERVICE"
assert_eq "PUT applied costObject" "$CO" "PROJ-2026-Q4"

# ───── 3. GET /invoices/cost-centers ─────
echo
echo "=== 3. GET /invoices/cost-centers (distinct) ==="
# Stage: we also create a 2nd invoice stamped VERTRIEB so the
# distinct list sees two distinct centers (VERTRIEB + SERVICE).
INV2_BODY=$(cat <<JSON
{
  "customerId": "$CUSTOMER_ID",
  "type": "INV",
  "issueDate": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "costCenter": "VERTRIEB",
  "costObject": "PROJ-2026-Q3",
  "items": [{"description":"x","quantity":1,"unitPrice":50,"vatRate":0.19}]
}
JSON
)
curl -sS -o /tmp/t39_inv3.json -X POST \
  "$API/api/v1/invoices?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d "$INV2_BODY" > /dev/null

curl -sS -o /tmp/t39_cc.json -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/invoices/cost-centers?companyId=$COMPANY_ID" > /dev/null
LIST=$(python3 -c "import json; print(','.join(json.load(open('/tmp/t39_cc.json'))['costCenters']))")
echo "  costCenters: $LIST"
echo "$LIST" | grep -q "VERTRIEB" || (echo "FATAL: VERTRIEB not in list" && exit 1)
echo "$LIST" | grep -q "SERVICE" || (echo "FATAL: SERVICE not in list" && exit 1)
echo "  ✓ both VERTRIEB + SERVICE present"

# ───── 4. GET with ?costCenter= filter returns costObjects ─────
echo
echo "=== 4. GET /invoices/cost-centers?costCenter=VERTRIEB ==="
curl -sS -o /tmp/t39_cc_filt.json -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/invoices/cost-centers?companyId=$COMPANY_ID&costCenter=VERTRIEB" > /dev/null
OBJS=$(python3 -c "import json; print(','.join(json.load(open('/tmp/t39_cc_filt.json'))['costObjects']))")
echo "  costObjects(VERTRIEB): $OBJS"
echo "$OBJS" | grep -q "PROJ-2026-Q3" || (echo "FATAL: PROJ-2026-Q3 not in filter result" && exit 1)
echo "  ✓ PROJ-2026-Q3 present"

# ───── 5. Bad inputs ─────
echo
echo "=== 5. Bad inputs ==="
STATUS=$(curl -sS -o /tmp/t39_bad.json -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/invoices/cost-centers")
assert_eq "missing companyId returns 400" "$STATUS" "400"

# Empty-string costCenter is coerced to null (no "" rows
# in DB) — verify by stamping one and checking the list.
INV4_BODY=$(cat <<JSON
{"customerId":"$CUSTOMER_ID","type":"INV","issueDate":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","costCenter":"  ","items":[{"description":"x","quantity":1,"unitPrice":1,"vatRate":0.19}]}
JSON
)
curl -sS -o /tmp/t39_inv4.json -X POST \
  "$API/api/v1/invoices?companyId=$COMPANY_ID" \
  -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  -d "$INV4_BODY" > /dev/null
EMPTY_CC=$(python3 -c "import json; d=json.load(open('/tmp/t39_inv4.json')); print(repr(d.get('costCenter')))")
assert_eq "empty costCenter coerced to null" "$EMPTY_CC" "None"

# ───── Cleanup ─────
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL
DELETE FROM "Invoice" WHERE "customerId" IN (SELECT id FROM "Customer" WHERE "name" = 'Tier39 CC Customer' AND "companyId" = '$COMPANY_ID');
DELETE FROM "Customer" WHERE "name" = 'Tier39 CC Customer' AND "companyId" = '$COMPANY_ID';
SQL

if [ -n "$FAILS" ]; then
  echo "$FAILS assertion(s) FAILED"
  exit 1
fi
echo
echo "ALL PASSED"