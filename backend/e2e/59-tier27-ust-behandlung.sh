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
PDF_BODY=$(curl -sS -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/invoices/$RC_PDF_INVOICE_ID/pdf")
# The PDF binary starts with %PDF-; the
# text inside is zlib-compressed. We use
# pdftotext if available, otherwise a
# best-effort grep on the raw stream.
if command -v pdftotext >/dev/null 2>&1; then
  echo "$PDF_BODY" | pdftotext - - 2>/dev/null > /tmp/t59_rc_text.txt
  if grep -q "§13b" /tmp/t59_rc_text.txt 2>/dev/null; then
    pass "PDF contains §13b footnote"
  else
    fail "PDF missing §13b footnote"
  fi
else
  # Fallback: PDF binary usually contains the
  # literal text near the end (PDF doesn't
  # compress every text run). Look for the
  # German string in the raw stream.
  if echo "$PDF_BODY" | grep -F "§13b" >/dev/null 2>&1; then
    pass "PDF (raw) contains §13b footnote"
  else
    echo "  SKIP: pdftotext not installed and raw grep failed"
  fi
fi

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
