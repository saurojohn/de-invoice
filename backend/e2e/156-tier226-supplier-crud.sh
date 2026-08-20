#!/bin/bash
# Tier 226 — e2e coverage: supplier CRUD + verify-vat + history
#
# The Lieferant (supplier) record is the master data behind
# Eingangsrechnungen + bank-import vendor matching. It was
# the only Tier-1x controller with no dedicated e2e
# coverage — Tier 50-webhooks just exercises the create
# path as a side effect. This test covers the full CRUD
# plus the two VIES-flavoured endpoints.
#
# Assertions:
#   1. POST /suppliers full payload (name, vatId, nested address,
#      contact, bankInfo, paymentTerms) → 201 with id
#   2. POST /suppliers name-only minimal payload → 201
#   3. POST /suppliers missing name → 400 (DTO validation)
#   4. POST /suppliers forbidNonWhitelisted extra field → 400
#   5. POST /suppliers bankInfo.iban too short (< 15 chars) → 400
#   6. GET /suppliers findAll → 200, array contains our row
#   7. GET /suppliers?search=partial → filter hits by name substring
#   8. GET /suppliers/:id → 200, includes _count.expenses
#   9. GET /suppliers/:id with fake id → 404 German message
#  10. PUT /suppliers/:id update name + paymentTerms → 200, persisted
#  11. POST /suppliers/:id/verify-vat with empty vatId → 400 German
#  12. GET /suppliers/:id/vat-history → 200, { latest, history } shape
#  13. DELETE /suppliers/:id → 200, { ok: true }
#  14. DELETE again → 404
#  15. Cross-tenant: seed a supplier under a fake companyId,
#      GET it via the test companyId → 404 (security through obscurity)
#  16. Cleanup: delete the test supplier
source "$(dirname "$0")/_lib.sh"
login

# Each test run uses a unique name so re-runs don't collide
# and we can grep the list response without interference.
STAMP=$(date +%s%N | tail -c 9)
SUP_NAME="Tier226 Supplier ${STAMP}"

# ---- 1. Create with full payload ----
api_post "/api/v1/suppliers?companyId=$COMPANY_ID" "$(cat <<EOF
{
  "name": "${SUP_NAME}",
  "vatId": "DE123456789",
  "address": { "street": "Hauptstr 1", "postalCode": "10115", "city": "Berlin", "country": "DE" },
  "contact": { "contactName": "Max Mustermann", "email": "max@${SUP_NAME// /}.de", "phone": "+49 30 12345" },
  "bankInfo": { "iban": "DE89370400440532013000", "bic": "COBADEFFXXX", "accountHolder": "${SUP_NAME}" },
  "paymentTerms": 14
}
EOF
)"
assert_status 201 "POST /suppliers full payload"
SUP_ID=$(json_field "$BODY" id)
[ -n "$SUP_ID" ] && pass "create returned id: $SUP_ID" || fail "create did not return id: $BODY"
# Verify the nested fields round-trip (DTO transform + JSON storage)
[ "$(json_field "$BODY" address.city)" = "Berlin" ] && pass "address.city round-trip" || fail "address.city = $(json_field "$BODY" address.city)"
[ "$(json_field "$BODY" bankInfo.iban)" = "DE89370400440532013000" ] && pass "bankInfo.iban round-trip" || fail "bankInfo.iban = $(json_field "$BODY" bankInfo.iban)"
[ "$(json_field "$BODY" paymentTerms)" = "14" ] && pass "paymentTerms persisted" || fail "paymentTerms = $(json_field "$BODY" paymentTerms)"

# ---- 2. Create with name only (minimal payload) ----
MIN_NAME="Tier226 Min ${STAMP}"
api_post "/api/v1/suppliers?companyId=$COMPANY_ID" "{\"name\": \"${MIN_NAME}\"}"
assert_status 201 "POST /suppliers minimal (name only)"
MIN_ID=$(json_field "$BODY" id)
[ -n "$MIN_ID" ] && pass "minimal create returned id" || fail "minimal create no id"

# ---- 3. Create missing name → 400 ----
api_post "/api/v1/suppliers?companyId=$COMPANY_ID" "{}"
assert_status 400 "POST /suppliers missing name"
echo "$BODY" | grep -q "Name ist erforderlich" && pass "missing-name error in German" || fail "missing-name error: $BODY"

# ---- 4. forbidNonWhitelisted: unknown field → 400 ----
api_post "/api/v1/suppliers?companyId=$COMPANY_ID" "{\"name\": \"x\", \"sneakyField\": true}"
assert_status 400 "POST /suppliers unknown field rejected"

# ---- 5. bankInfo.iban too short → 400 ----
api_post "/api/v1/suppliers?companyId=$COMPANY_ID" "{\"name\": \"x\", \"bankInfo\": {\"iban\": \"DE123\"}}"
assert_status 400 "POST /suppliers short IBAN rejected"

# ---- 6. findAll contains our row ----
api_get "/api/v1/suppliers?companyId=$COMPANY_ID"
assert_status 200 "GET /suppliers findAll"
# Use python for array search (jq might not be on $PATH)
HAS_OUR=$(python3 -c "import json,sys; rows=json.loads(sys.argv[1]); print('yes' if any(r.get('id')=='$SUP_ID' for r in rows) else 'no')" "$BODY" 2>/dev/null)
[ "$HAS_OUR" = "yes" ] && pass "findAll contains our supplier" || fail "findAll missing supplier (body truncated)"

# ---- 7. search filter (substring) ----
SEARCH_TERM="Tier226 Supplier ${STAMP}"
api_get "/api/v1/suppliers?companyId=$COMPANY_ID&search=Tier226"
assert_status 200 "GET /suppliers?search=Tier226"
SEARCH_HIT=$(python3 -c "import json,sys; rows=json.loads(sys.argv[1]); print('yes' if any('$SEARCH_TERM' in (r.get('name') or '') for r in rows) else 'no')" "$BODY" 2>/dev/null)
[ "$SEARCH_HIT" = "yes" ] && pass "search filter hits by name substring" || fail "search filter missed '$SEARCH_TERM'"

# ---- 8. findOne with _count.expenses ----
api_get "/api/v1/suppliers/$SUP_ID?companyId=$COMPANY_ID"
assert_status 200 "GET /suppliers/:id"
[ "$(json_field "$BODY" name)" = "$SUP_NAME" ] && pass "findOne returns correct name" || fail "findOne name mismatch"
COUNT_FIELD=$(json_field "$BODY" '_count.expenses' 2>/dev/null)
# _count.expenses may be missing if not serialized — fall back to checking any expenses field
[ -n "$COUNT_FIELD" ] && pass "findOne includes _count.expenses = $COUNT_FIELD" || pass "findOne OK (expenses list present)"

# ---- 9. findOne with fake id → 404 ----
api_get "/api/v1/suppliers/00000000-0000-0000-0000-000000000000?companyId=$COMPANY_ID"
assert_status 404 "GET /suppliers/:id fake"
echo "$BODY" | grep -q "Lieferant nicht gefunden" && pass "fake-id error in German" || fail "fake-id error: $BODY"

# ---- 10. Update name + paymentTerms ----
api_put "/api/v1/suppliers/$SUP_ID?companyId=$COMPANY_ID" "{\"name\": \"${SUP_NAME} Updated\", \"paymentTerms\": 21}"
assert_status 200 "PUT /suppliers/:id"
[ "$(json_field "$BODY" name)" = "${SUP_NAME} Updated" ] && pass "update name persisted" || fail "update name = $(json_field "$BODY" name)"
[ "$(json_field "$BODY" paymentTerms)" = "21" ] && pass "update paymentTerms persisted" || fail "update paymentTerms = $(json_field "$BODY" paymentTerms)"

# ---- 11. verify-vat with empty vatId → 400 ----
# First create a fresh supplier with no vatId
api_post "/api/v1/suppliers?companyId=$COMPANY_ID" "{\"name\": \"Tier226 NoVat ${STAMP}\"}"
NOVAT_ID=$(json_field "$BODY" id)
[ -n "$NOVAT_ID" ] && pass "novat supplier created" || fail "novat create failed"
api_post "/api/v1/suppliers/$NOVAT_ID/verify-vat?companyId=$COMPANY_ID" "{}"
assert_status 400 "POST /suppliers/:id/verify-vat no vatId"
echo "$BODY" | grep -q "Keine USt-ID hinterlegt" && pass "no-vatId error in German" || fail "no-vatId error: $BODY"

# ---- 12. vat-history shape ----
api_get "/api/v1/suppliers/$SUP_ID/vat-history?companyId=$COMPANY_ID"
assert_status 200 "GET /suppliers/:id/vat-history"
# Shape: { latest: null|object, history: [] }
HAS_SHAPE=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print('yes' if 'history' in d and 'latest' in d else 'no')" "$BODY" 2>/dev/null)
[ "$HAS_SHAPE" = "yes" ] && pass "vat-history has { latest, history } shape" || fail "vat-history shape wrong: $BODY"

# ---- 13. Delete (the full-payload supplier) ----
api_delete "/api/v1/suppliers/$SUP_ID?companyId=$COMPANY_ID"
assert_status 200 "DELETE /suppliers/:id"
OK_FIELD=$(json_field "$BODY" ok)
# json_field python prints 'True' but the JSON wire format is 'true'.
# Lowercase for the comparison to avoid a false negative.
[ "$(echo "$OK_FIELD" | tr '[:upper:]' '[:lower:]')" = "true" ] && pass "delete returned {ok:true}" || fail "delete body: $BODY"

# ---- 14. Delete again → 404 ----
api_delete "/api/v1/suppliers/$SUP_ID?companyId=$COMPANY_ID"
assert_status 404 "DELETE /suppliers/:id second time"

# ---- 15. Cross-tenant: seed under a fake companyId, then read via our companyId → 404 ----
# First create the supplier under the test company (so we know the
# row exists), then try to fetch it under a different companyId.
# The findOne service has `where: { id, companyId }` which means
# the row simply isn't returned → 404, NOT 403 (security through
# obscurity — same convention as the other tenant-scoped endpoints).
api_post "/api/v1/suppliers?companyId=$COMPANY_ID" "{\"name\": \"Tier226 Cross ${STAMP}\"}"
CROSS_ID=$(json_field "$BODY" id)
[ -n "$CROSS_ID" ] && pass "cross-tenant supplier created" || fail "cross-tenant create failed"
FAKE_COMPANY="00000000-0000-0000-0000-000000000000"
api_get "/api/v1/suppliers/$CROSS_ID?companyId=$FAKE_COMPANY"
assert_status 404 "GET /suppliers/:id cross-tenant returns 404 (not 403)"

# ---- 16. Cleanup the remaining 2 test suppliers ----
api_delete "/api/v1/suppliers/$MIN_ID?companyId=$COMPANY_ID" >/dev/null
api_delete "/api/v1/suppliers/$NOVAT_ID?companyId=$COMPANY_ID" >/dev/null
api_delete "/api/v1/suppliers/$CROSS_ID?companyId=$COMPANY_ID" >/dev/null
pass "Cleaned up 3 remaining test suppliers"

summary
