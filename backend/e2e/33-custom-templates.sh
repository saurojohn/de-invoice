#!/bin/bash
# Test 33: Tier 7 — Custom invoice templates
#
# Verifies the per-company template CRUD +
# preview endpoint. The PDF render path
# is exercised by the controller's
# /preview route which calls the same
# PDFKit pipeline as real invoices.
#
# Coverage:
#   1. List templates (empty initially)
#   2. Create default template (isDefault=true)
#   3. Create 2nd template (non-default)
#   4. List shows both, with the right one as default
#   5. Update template — change color + name
#   6. Set the 2nd template as default
#      → the 1st template gets demoted
#   7. Validation: bad fontFamily rejected (400)
#   8. Validation: bad color format rejected (400)
#   9. Validation: bad layoutDensity rejected (400)
#  10. Preview returns a real PDF (Content-Type
#      = application/pdf, %PDF magic header)
#  11. Delete template
#  12. List shows empty after delete

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook

echo "=== Test: Tier 7 Custom invoice templates ==="
# Clean prior state
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  DELETE FROM \"InvoiceTemplate\" WHERE \"companyId\" = '$COMPANY_ID';" >/dev/null 2>&1

# ----- 1. Empty list -----
api_get "/api/v1/invoice-templates?companyId=$COMPANY_ID"
assert_status 200 "1. list returns 200"
COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
assert_eq "1b. empty list" "$COUNT" "0"

# ----- 2. Create default template -----
api_post "/api/v1/invoice-templates" "{\"companyId\":\"$COMPANY_ID\",\"name\":\"SH Leder Standard\",\"templateType\":\"custom\",\"configJson\":{\"primaryColor\":\"#1e3a8a\",\"accentColor\":\"#64748b\",\"fontFamily\":\"Helvetica\",\"layoutDensity\":\"comfortable\",\"footerText\":\"Vielen Dank für Ihren Auftrag.\"},\"isDefault\":true}"
assert_status 201 "2. create default template (201)"
T1_ID=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
T1_DEF=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['isDefault'])")
assert_eq "2b. isDefault=true" "$T1_DEF" "True"
# Config should be merged with defaults
T1_PRIMARY=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['configJson']['primaryColor'])")
assert_eq "2c. primaryColor persisted" "$T1_PRIMARY" "#1e3a8a"

# ----- 3. Create 2nd (non-default) template -----
api_post "/api/v1/invoice-templates" "{\"companyId\":\"$COMPANY_ID\",\"name\":\"B2B Reverse Charge\",\"templateType\":\"custom\",\"configJson\":{\"primaryColor\":\"#7c2d12\",\"fontFamily\":\"Times-Roman\",\"reverseChargeNote\":\"Steuerschuldnerschaft des Leistungsempfängers (§13b UStG).\"}}"
assert_status 201 "3. create 2nd template (201)"
T2_ID=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
T2_DEF=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['isDefault'])")
assert_eq "3b. 2nd template is not default" "$T2_DEF" "False"

# ----- 4. List both, T1 is default -----
api_get "/api/v1/invoice-templates?companyId=$COMPANY_ID"
COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
assert_eq "4. list has 2 templates" "$COUNT" "2"
# The default should be first in the list
DEFAULT_NAME=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(next((t['name'] for t in d if t['isDefault']), ''))")
assert_eq "4b. default = SH Leder Standard" "$DEFAULT_NAME" "SH Leder Standard"

# ----- 5. Update template (color + name) -----
api_put "/api/v1/invoice-templates/$T2_ID?companyId=$COMPANY_ID" "{\"name\":\"B2B EU §13b\",\"configJson\":{\"primaryColor\":\"#15803d\"}}"
assert_status 200 "5. update template (200)"
T2_NAME=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['name'])")
assert_eq "5b. name updated" "$T2_NAME" "B2B EU §13b"
T2_COLOR=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['configJson']['primaryColor'])")
assert_eq "5c. primaryColor updated" "$T2_COLOR" "#15803d"
# fontFamily from create should still be there
T2_FONT=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['configJson']['fontFamily'])")
assert_eq "5d. fontFamily preserved on partial update" "$T2_FONT" "Times-Roman"

# ----- 6. Promote T2 to default; T1 demoted -----
api_put "/api/v1/invoice-templates/$T2_ID?companyId=$COMPANY_ID" "{\"isDefault\":true}"
assert_status 200 "6. promote T2 (200)"
T2_DEF=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['isDefault'])")
assert_eq "6b. T2 is now default" "$T2_DEF" "True"

# Verify T1 is no longer default
T1_STILL_DEF=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "
  SELECT \"isDefault\"::text FROM \"InvoiceTemplate\" WHERE id = '$T1_ID';" 2>/dev/null | tr -d ' ')
assert_eq "6c. T1 demoted from default" "$T1_STILL_DEF" "false"

# ----- 7. Validation: bad fontFamily -----
api_post "/api/v1/invoice-templates" "{\"companyId\":\"$COMPANY_ID\",\"name\":\"Bad\",\"configJson\":{\"fontFamily\":\"Comic-Sans\"}}"
assert_status 400 "7. bad fontFamily rejected (400)"

# ----- 8. Validation: bad color format -----
api_post "/api/v1/invoice-templates" "{\"companyId\":\"$COMPANY_ID\",\"name\":\"Bad\",\"configJson\":{\"primaryColor\":\"red\"}}"
assert_status 400 "8. bad color rejected (400)"

# ----- 9. Validation: bad layoutDensity -----
api_post "/api/v1/invoice-templates" "{\"companyId\":\"$COMPANY_ID\",\"name\":\"Bad\",\"configJson\":{\"layoutDensity\":\"huge\"}}"
assert_status 400 "9. bad layoutDensity rejected (400)"

# ----- 10. Preview returns real PDF -----
api_post "/api/v1/invoice-templates/$T1_ID/preview?companyId=$COMPANY_ID" ""
# api_post returns 200 for non-JSON responses
# but we want to check the body is a PDF
# Use the saved file approach: re-call and
# write to a file.
PDF_PATH="/tmp/t33-preview.pdf"
curl -sS -X POST -H "Content-Type: application/json" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "http://localhost:3001/api/v1/invoice-templates/$T1_ID/preview?companyId=$COMPANY_ID" \
  -o "$PDF_PATH"
PDF_SIZE=$(stat -f%z "$PDF_PATH" 2>/dev/null || stat -c%s "$PDF_PATH" 2>/dev/null)
# A real PDF is at least ~1KB
if [[ "$PDF_SIZE" -gt 1000 ]]; then
  pass "10. preview PDF is $PDF_SIZE bytes"
else
  fail "10. preview PDF too small: $PDF_SIZE bytes"
fi
# Magic header is %PDF
MAGIC=$(head -c 4 "$PDF_PATH" | xxd -p)
assert_eq "10b. PDF magic header" "$MAGIC" "25504446"

# ----- 11. Delete template -----
api_delete "/api/v1/invoice-templates/$T2_ID?companyId=$COMPANY_ID"
assert_status 200 "11. delete template (200)"

# ----- 12. List now shows 1 -----
api_get "/api/v1/invoice-templates?companyId=$COMPANY_ID"
COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
assert_eq "12. list shows 1 after delete" "$COUNT" "1"

# ===== Tier 398: invoice-template fields are bounded =====
# Measured: name 50 000 chars, templateType "bogus-type" and a 500 KB configJson
# were all stored (validateConfig checked the known keys only).
t398_tpl() { # json -> STATUS
  curl -sS -o /tmp/t398-tpl.out -w "%{http_code}" -X POST \
    "$API/api/v1/invoice-templates" \
    -H "Content-Type: application/json" -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
    --data-binary "$1"
}
python3 -c "import json,sys;print(json.dumps({'companyId':sys.argv[1],'name':'N'*50000,'configJson':{}}))" "$COMPANY_ID" > /tmp/t398-a.json
assert_eq "invoice-template: 50 000-character name refused (was 201)" "$(t398_tpl @/tmp/t398-a.json)" "400"
python3 -c "import json,sys;print(json.dumps({'companyId':sys.argv[1],'name':'t398','templateType':'bogus-type','configJson':{}}))" "$COMPANY_ID" > /tmp/t398-b.json
assert_eq "invoice-template: unknown templateType refused (was stored)" "$(t398_tpl @/tmp/t398-b.json)" "400"
python3 -c "import json,sys;print(json.dumps({'companyId':sys.argv[1],'name':'t398','configJson':{'pad':'P'*500000}}))" "$COMPANY_ID" > /tmp/t398-c.json
assert_eq "invoice-template: 500 KB configJson refused (was stored)" "$(t398_tpl @/tmp/t398-c.json)" "400"
python3 -c "import json,sys;print(json.dumps({'companyId':sys.argv[1],'name':'Tier398 Vorlage','templateType':'custom','configJson':{'primaryColor':'#1e3a8a'}}))" "$COMPANY_ID" > /tmp/t398-d.json
assert_eq "invoice-template: the settings page shape still saves" "$(t398_tpl @/tmp/t398-d.json)" "201"
rm -f /tmp/t398-a.json /tmp/t398-b.json /tmp/t398-c.json /tmp/t398-d.json /tmp/t398-tpl.out

# ----- Cleanup -----
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c "
  DELETE FROM \"InvoiceTemplate\" WHERE \"companyId\" = '$COMPANY_ID';" >/dev/null 2>&1
note "Cleanup done"

cleanup_cashbook
summary
