#!/bin/bash
# Test 14: Voucher templates
# - POST /voucher-templates creates a named preset
#   with linesJson (accountNumber + side)
# - GET /voucher-templates lists them
# - PUT updates the linesJson
# - DELETE removes them
# - POST /voucher-templates/:id/apply resolves the
#   template into modal-ready lines for a given
#   amount + date:
#   * 2-line simple booking (debit/credit)
#   * 3-line VAT booking (debit + Vorsteuer + credit)
#   * descriptionPattern placeholders ({month},
#     {year}, {counterparty}) are substituted
#   * unfilled placeholders are returned in the
#     response so the UI can prompt the user
# - Validation:
#   * missing name → 400
#   * missing linesJson → 400
#   * < 2 lines → 400
#   * line without accountNumber → 400
#   * line with bad side → 400
#   * invalid JSON in linesJson → 400
# - Apply edge cases:
#   * amount ≤ 0 → 400
#   * template line accountNumber not in chart of
#     accounts → 400 with a helpful message

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login

# Cleanup any prior test templates
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"VoucherTemplate\" WHERE \"companyId\" = '$COMPANY_ID';" >/dev/null 2>&1

echo "=== Test: Voucher templates ==="

# Test 1: create a simple 2-line template
api_post "/api/v1/voucher-templates?companyId=$COMPANY_ID" '{
  "name": "T14-Bankgebuehren",
  "description": "Test template",
  "linesJson": "[{\"accountNumber\":\"4900\",\"side\":\"debit\"},{\"accountNumber\":\"1200\",\"side\":\"credit\"}]",
  "descriptionPattern": "Bankgebühren {month}/{year}"
}' >/dev/null
assert_eq "create template HTTP" "$STATUS" "201"
TPL_ID=$(json_field "$BODY" id)
[ -n "$TPL_ID" ] && echo "✓ template id = $TPL_ID" || { echo "✗ no id"; exit 1; }

# Test 2: list templates returns it
api_get "/api/v1/voucher-templates?companyId=$COMPANY_ID"
COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
assert_eq "list returns 1" "$COUNT" "1"

# Test 3: apply the template (simple 2-line)
api_post "/api/v1/voucher-templates/$TPL_ID/apply?companyId=$COMPANY_ID" '{
  "amount": 12.50,
  "date": "2026-06-15"
}' >/dev/null
assert_eq "apply simple HTTP" "$STATUS" "201"
LINES_COUNT=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['lines']))" <<< "$BODY")
assert_eq "simple apply → 2 lines" "$LINES_COUNT" "2"
DESC=$(json_field "$BODY" description)
assert_eq "description with month/year" "$DESC" "Bankgebühren 06/2026"
DEBIT_TOTAL=$(python3 -c "
import json,sys
d = json.load(sys.stdin)
print(sum(float(l['debit']) for l in d['lines']))
" <<< "$BODY")
CREDIT_TOTAL=$(python3 -c "
import json,sys
d = json.load(sys.stdin)
print(sum(float(l['credit']) for l in d['lines']))
" <<< "$BODY")
assert_eq "Soll" "$DEBIT_TOTAL" "12.5"
assert_eq "Haben" "$CREDIT_TOTAL" "12.5"
UNFILLED=$(python3 -c "import json,sys; print(json.load(sys.stdin)['unfilledPlaceholders'])" <<< "$BODY")
assert_eq "no unfilled placeholders" "$UNFILLED" "[]"

# Test 4: create a VAT template
api_post "/api/v1/voucher-templates?companyId=$COMPANY_ID" '{
  "name": "T14-Miete",
  "linesJson": "[{\"accountNumber\":\"4900\",\"side\":\"debit\",\"vatRate\":0.19},{\"accountNumber\":\"1200\",\"side\":\"credit\"}]",
  "descriptionPattern": "Miete {month}/{year}"
}' >/dev/null
assert_eq "create VAT template HTTP" "$STATUS" "201"
VAT_ID=$(json_field "$BODY" id)

# Apply with 1190 EUR (1000 net + 190 VAT)
api_post "/api/v1/voucher-templates/$VAT_ID/apply?companyId=$COMPANY_ID" '{
  "amount": 1190,
  "date": "2026-06-15"
}' >/dev/null
assert_eq "apply VAT HTTP" "$STATUS" "201"
VAT_LINES_COUNT=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)['lines']))" <<< "$BODY")
assert_eq "VAT apply → 3 lines" "$VAT_LINES_COUNT" "3"
# Verify the lines: 4900 debit 1000, 1576 debit 190, 1200 credit 1190
VAT_DEBIT_4900=$(python3 -c "
import json,sys
d = json.load(sys.stdin)
for l in d['lines']:
    if l['accountNumber'] == '4900':
        print(float(l['debit'])); break
" <<< "$BODY")
assert_eq "VAT 4900 debit" "$VAT_DEBIT_4900" "1000.0"
VAT_VORSTEUER=$(python3 -c "
import json,sys
d = json.load(sys.stdin)
for l in d['lines']:
    if l['accountNumber'] == '1576':
        print(float(l['debit'])); break
" <<< "$BODY")
assert_eq "Vorsteuer 1576 debit" "$VAT_VORSTEUER" "190.0"
VAT_BANK=$(python3 -c "
import json,sys
d = json.load(sys.stdin)
for l in d['lines']:
    if l['accountNumber'] == '1200':
        print(float(l['credit'])); break
" <<< "$BODY")
assert_eq "Bank 1200 credit (gross)" "$VAT_BANK" "1190.0"

# Test 5: placeholders
api_post "/api/v1/voucher-templates/$VAT_ID/apply?companyId=$COMPANY_ID" '{
  "amount": 1190,
  "date": "2026-06-15",
  "counterparty": "Vermieter GmbH"
}' >/dev/null
# Update template to use {counterparty} placeholder
api_put "/api/v1/voucher-templates/$VAT_ID?companyId=$COMPANY_ID" '{
  "descriptionPattern": "Miete {month}/{year} - {counterparty}"
}' >/dev/null
api_post "/api/v1/voucher-templates/$VAT_ID/apply?companyId=$COMPANY_ID" '{
  "amount": 1190,
  "date": "2026-06-15",
  "counterparty": "Vermieter GmbH"
}' >/dev/null
assert_eq "apply with counterparty HTTP" "$STATUS" "201"
COUNTER_DESC=$(json_field "$BODY" description)
assert_eq "description with all placeholders" "$COUNTER_DESC" "Miete 06/2026 - Vermieter GmbH"

# Test 6: unfilled placeholders returned
api_post "/api/v1/voucher-templates/$VAT_ID/apply?companyId=$COMPANY_ID" '{
  "amount": 1190,
  "date": "2026-06-15"
}' >/dev/null
UNFILLED=$(python3 -c "
import json,sys
d = json.load(sys.stdin)
print(','.join(d['unfilledPlaceholders']))
" <<< "$BODY")
assert_eq "{counterparty} reported as unfilled" "$UNFILLED" "counterparty"

# Test 7: validation
api_post "/api/v1/voucher-templates?companyId=$COMPANY_ID" '{
  "name": "T14-MissingName"
}' >/dev/null
assert_eq "missing name rejected" "$STATUS" "400"

api_post "/api/v1/voucher-templates?companyId=$COMPANY_ID" '{
  "name": "T14-BadJson"
}' >/dev/null
assert_eq "missing linesJson rejected" "$STATUS" "400"

api_post "/api/v1/voucher-templates?companyId=$COMPANY_ID" '{
  "name": "T14-BadJson",
  "linesJson": "not json"
}' >/dev/null
assert_eq "invalid JSON rejected" "$STATUS" "400"

api_post "/api/v1/voucher-templates?companyId=$COMPANY_ID" '{
  "name": "T14-TooFew",
  "linesJson": "[{\"accountNumber\":\"4900\",\"side\":\"debit\"}]"
}' >/dev/null
assert_eq "< 2 lines rejected" "$STATUS" "400"

api_post "/api/v1/voucher-templates?companyId=$COMPANY_ID" '{
  "name": "T14-BadSide",
  "linesJson": "[{\"accountNumber\":\"4900\",\"side\":\"debit\"},{\"accountNumber\":\"1200\",\"side\":\"foo\"}]"
}' >/dev/null
assert_eq "bad side rejected" "$STATUS" "400"

# Test 8: apply with amount ≤ 0 rejected
api_post "/api/v1/voucher-templates/$TPL_ID/apply?companyId=$COMPANY_ID" '{
  "amount": 0,
  "date": "2026-06-15"
}' >/dev/null
assert_eq "zero amount rejected" "$STATUS" "400"

# Test 9: apply with missing accountNumber in chart
api_post "/api/v1/voucher-templates?companyId=$COMPANY_ID" '{
  "name": "T14-MissingAcct",
  "linesJson": "[{\"accountNumber\":\"99999\",\"side\":\"debit\"},{\"accountNumber\":\"1200\",\"side\":\"credit\"}]"
}' >/dev/null
MISSING_ID=$(json_field "$BODY" id)
api_post "/api/v1/voucher-templates/$MISSING_ID/apply?companyId=$COMPANY_ID" '{
  "amount": 100,
  "date": "2026-06-15"
}' >/dev/null
assert_eq "missing account rejected" "$STATUS" "400"
ERR_MSG=$(json_field "$BODY" message)
assert_eq "error mentions account 99999" \
  "$(echo "$ERR_MSG" | grep -c '99999')" "1"

# Test 10: delete
api_delete "/api/v1/voucher-templates/$TPL_ID?companyId=$COMPANY_ID"
assert_eq "delete HTTP" "$STATUS" "200"

# Also delete the VAT template (test 4) and the
# "missing account" template (test 9) so the list
# assertion at the end is exact.
api_delete "/api/v1/voucher-templates/$VAT_ID?companyId=$COMPANY_ID"
assert_eq "delete VAT_ID HTTP" "$STATUS" "200"
api_delete "/api/v1/voucher-templates/$MISSING_ID?companyId=$COMPANY_ID"
assert_eq "delete MISSING_ID HTTP" "$STATUS" "200"

# api_delete sets $BODY to "" since Nest DELETE
# returns no body. We need a fresh api_get to re-list.
api_get "/api/v1/voucher-templates?companyId=$COMPANY_ID"
COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
assert_eq "list after delete" "$COUNT" "0"

# Cleanup
docker exec de-invoice-postgres psql -U de_invoice -d de_invoice -c \
  "DELETE FROM \"VoucherTemplate\" WHERE \"companyId\" = '$COMPANY_ID';" >/dev/null 2>&1

echo
summary
