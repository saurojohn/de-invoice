#!/usr/bin/env bash
# e2e 59: Tier 27 — USt-Behandlung (reverseCharge / euTransaction)
#
# Verifies the new booleans on the Invoice model:
#   1. POST a new invoice with reverseCharge=true —
#      response includes reverseCharge=true and
#      euTransaction=false; the PDF endpoint also
#      serves the invoice (the PDF must include
#      the §13b note text).
#   2. POST a new invoice with euTransaction=true —
#      response includes euTransaction=true and
#      reverseCharge=false; the PDF must include
#      the §1a note text.
#   3. POST with BOTH true → 400 (the §13b/§1a
#      contradiction guard).
#   4. PUT an existing invoice to switch from
#      reverseCharge=true back to false (in the
#      same-day edit window) — the toggle round-
#      trips correctly.
#
# The §13b/§1a notes are short German strings,
# so the PDF smoke check extracts the text and
# asserts on a substring. The PDF binary is
# fetched via the standard /invoices/:id/pdf
# endpoint; the test only inspects the text
# payload, not the rendered layout.
#
# Run with the same prerequisites as e2e 25:
# backend on :3001, Postgres container up.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

# Login (cached across tests in the same run).
login

# Pick the first customer of the test company.
# We need their id to issue invoices against.
api_get "/api/v1/companies/$COMPANY_ID"
CUSTOMER_ID=$(echo "$BODY" | python3 -c "
import json, sys
d = json.load(sys.stdin)
# The customer list isn't in the company
# endpoint directly — fetch it from the
# customers endpoint instead.
" 2>/dev/null || true)
# Fallback: hit the customers list directly.
# The endpoint returns {data: [...]} (paginated).
api_get "/api/v1/customers?companyId=$COMPANY_ID"
CUSTOMER_ID=$(echo "$BODY" | python3 -c "
import json, sys
d = json.load(sys.stdin)
items = d.get('data') if isinstance(d, dict) else d
if isinstance(items, list) and items:
    print(items[0]['id'])
")
if [[ -z "$CUSTOMER_ID" ]]; then
  echo "FATAL: no customer for company $COMPANY_ID" >&2
  exit 1
fi
echo "  Using customer: $CUSTOMER_ID"
pass "customer found"

# ---- 1. Create RC invoice ----
echo
echo "=== 1. reverseCharge=true invoice ==="
RC_BODY=$(cat <<EOF
{
  "customerId": "$CUSTOMER_ID",
  "issueDate": "$(date +%Y-%m-%d)",
  "reverseCharge": true,
  "euTransaction": false,
  "items": [
    {
      "description": "E2E-T59 RC item",
      "quantity": 1,
      "unit": "Stk",
      "unitPrice": 100,
      "vatRate": 0
    }
  ]
}
EOF
)
api_post "/api/v1/invoices?companyId=$COMPANY_ID" "$RC_BODY" > /dev/null
echo "$BODY" > /tmp/t59_rc_invoice.json
RC_INVOICE_ID=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))")
assert_status 201 "RC invoice created" "$RC_INVOICE_ID"

# Verify the response has the flag set
RC_FLAG=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('reverseCharge', False))")
EUE_FLAG=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('euTransaction', False))")
assert_eq "RC invoice has reverseCharge=true" "$RC_FLAG" "True"
assert_eq "RC invoice has euTransaction=false" "$EUE_FLAG" "False"

# Re-fetch to confirm persistence.
api_get "/api/v1/invoices/$RC_INVOICE_ID?companyId=$COMPANY_ID" > /dev/null
RC_FLAG_FETCH=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('reverseCharge', False))")
assert_eq "RC invoice persists reverseCharge" "$RC_FLAG_FETCH" "True"

# ---- 2. Create IgE invoice ----
echo
echo "=== 2. euTransaction=true invoice ==="
IGE_BODY=$(cat <<EOF
{
  "customerId": "$CUSTOMER_ID",
  "issueDate": "$(date +%Y-%m-%d)",
  "reverseCharge": false,
  "euTransaction": true,
  "items": [
    {
      "description": "E2E-T59 IgE item",
      "quantity": 1,
      "unit": "Stk",
      "unitPrice": 200,
      "vatRate": 0
    }
  ]
}
EOF
)
api_post "/api/v1/invoices?companyId=$COMPANY_ID" "$IGE_BODY" > /dev/null
IGE_INVOICE_ID=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))")
assert_status 201 "IgE invoice created" "$IGE_INVOICE_ID"

EUE_FLAG=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('euTransaction', False))")
RC_FLAG=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('reverseCharge', False))")
assert_eq "IgE invoice has euTransaction=true" "$EUE_FLAG" "True"
assert_eq "IgE invoice has reverseCharge=false" "$RC_FLAG" "False"

# ---- 3. Contradiction: both true → 400 ----
echo
echo "=== 3. §13b+§1a contradiction rejected ==="
BAD_BODY=$(cat <<EOF
{
  "customerId": "$CUSTOMER_ID",
  "issueDate": "$(date +%Y-%m-%d)",
  "reverseCharge": true,
  "euTransaction": true,
  "items": [
    {
      "description": "bad",
      "quantity": 1,
      "unit": "Stk",
      "unitPrice": 10,
      "vatRate": 0
    }
  ]
}
EOF
)
api_post "/api/v1/invoices?companyId=$COMPANY_ID" "$BAD_BODY" > /dev/null
CONTRADICTION_STATUS="$STATUS"
assert_eq "both-true is rejected" "$CONTRADICTION_STATUS" "400"
# Body should mention both §13b and §1a
CONTRADICTION_MSG=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('message',''))")
if [[ "$CONTRADICTION_MSG" == *"§13b"* && "$CONTRADICTION_MSG" == *"§1a"* ]]; then
  pass "error message names both §13b and §1a"
else
  fail "error message should name both §13b and §1a (got: $CONTRADICTION_MSG)"
fi

# ---- 4. Toggle: switch RC off via PUT ----
echo
echo "=== 4. Toggle reverseCharge off via PUT ==="
# The invoice was created today, so it's still
# in the same-day edit window. Build a minimal
# payload that keeps the existing items but
# flips reverseCharge to false.
api_get "/api/v1/invoices/$RC_INVOICE_ID?companyId=$COMPANY_ID" > /dev/null
ORIG_ITEMS=$(echo "$BODY" | python3 -c "
import json, sys
d = json.load(sys.stdin)
items = d.get('items', [])
out = []
for it in items:
    out.append({
        'description': it.get('description', ''),
        'quantity': it.get('quantity', 1),
        'unit': it.get('unit', 'Stk'),
        'unitPrice': float(it.get('unitPrice', 0)),
        'vatRate': float(it.get('vatRate', 0)),
    })
print(json.dumps(out))
")
TOGGLE_BODY=$(cat <<EOF
{
  "reverseCharge": false,
  "euTransaction": false,
  "items": $ORIG_ITEMS
}
EOF
)
api_put "/api/v1/invoices/$RC_INVOICE_ID?companyId=$COMPANY_ID" "$TOGGLE_BODY" > /dev/null
assert_status 200 "RC invoice toggled off" "$STATUS"

# Re-fetch
api_get "/api/v1/invoices/$RC_INVOICE_ID?companyId=$COMPANY_ID" > /dev/null
RC_AFTER=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('reverseCharge', False))")
assert_eq "after toggle: reverseCharge=false" "$RC_AFTER" "False"

# ---- 5. PDF smoke: RC invoice has §13b note ----
echo
echo "=== 5. PDF includes the §13b footnote ==="
# Re-create an RC invoice for the PDF check
# (we just toggled the previous one off).
api_post "/api/v1/invoices?companyId=$COMPANY_ID" "$RC_BODY" > /dev/null
RC_PDF_INVOICE_ID=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))")
# Tier 371: this check had never run in CI. Three things were wrong at once:
#   - the URL omitted ?companyId=, so the endpoint answered HTTP 500
#     {"error":"PDF generation failed"} — the "PDF" was a JSON error;
#   - the body went into a bash variable, which drops NUL bytes and corrupts
#     any real PDF before a tool could read it;
#   - the CI runner has no pdftotext, and a raw grep can never find text in a
#     FlateDecode stream — so the branch printed SKIP and moved on.
# Now: save to a file, assert it is a PDF, and read the text with
# _lib.sh's pdf_contains, which inflates the stream. Verified on a real RC
# invoice PDF: "§13b" and "Steuerschuldnerschaft" are found, unrelated words
# are not — so the check can actually fail.
RC_PDF_FILE=/tmp/t59_rc_invoice.pdf
PDF_HTTP=$(curl -sS -o "$RC_PDF_FILE" -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/invoices/$RC_PDF_INVOICE_ID/pdf?companyId=$COMPANY_ID")
assert_eq "RC invoice PDF HTTP status" "$PDF_HTTP" "200"
assert_eq "RC invoice PDF magic header" "$(head -c 5 "$RC_PDF_FILE" 2>/dev/null)" "%PDF-"
pdf_contains "§13b" "$RC_PDF_FILE"
case $? in
  0) pass "PDF contains the §13b reverse-charge footnote" ;;
  1) fail "PDF is missing the §13b reverse-charge footnote" ;;
  *) fail "could not decode the PDF text stream to look for §13b" ;;
esac

# ---- Cleanup ----
echo
echo "=== Cleanup ==="
mavis-trash /tmp/t59_rc_invoice.json /tmp/t59_rc_text.txt 2>/dev/null

if [[ $FAILS -gt 0 ]]; then
  echo
  echo "$FAILS assertion(s) FAILED"
  exit 1
fi
echo
summary
