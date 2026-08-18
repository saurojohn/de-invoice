#!/usr/bin/env bash
# e2e 77: Tier 50 — VoucherTemplate auto-persist (capture from voucher).
#
# Adds two endpoints to the tier-14 voucher-template
# module:
#   POST /voucher-templates/from-voucher/:voucherId
#   GET  /voucher-templates/list-for-apply
#
# Validates:
#   1. POST captures a voucher's lines into a new
#      template (with costCenter + costObject +
#      description per line, accountNumber resolved).
#   2. GET list-for-apply returns templates with
#      parsed lines ready to drop into the create-
#      voucher modal.
#   3. Bad inputs: missing companyId → 400, voucher
#      with <2 lines → 400.
#   4. Tier-14 endpoints (apply, list) still work
#      after the schema additions.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook
# ───── 0. Wipe prior tier-50 fixtures ─────
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "VoucherLine" WHERE "voucherId" IN (
  SELECT id FROM "Voucher" WHERE "companyId" = '$COMPANY_ID' AND "description" LIKE 'Tier50%'
);
DELETE FROM "Voucher"          WHERE "companyId" = '$COMPANY_ID' AND "description" LIKE 'Tier50%';
DELETE FROM "VoucherTemplate" WHERE "companyId" = '$COMPANY_ID' AND (
  "name" LIKE 'Tier50%' OR "description" LIKE 'Tier50%' OR "descriptionPattern" LIKE 'Tier50%'
);
SQL

# ───── 1. Seed a voucher ─────
SACHKONTO_4960=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT id FROM \"Account\" WHERE \"companyId\" = '$COMPANY_ID' AND \"accountNumber\" = '4960' LIMIT 1")
SACHKONTO_1200=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT id FROM \"Account\" WHERE \"companyId\" = '$COMPANY_ID' AND \"accountNumber\" = '1200' LIMIT 1")
[[ -n "$SACHKONTO_4960" && -n "$SACHKONTO_1200" ]] || (echo "FATAL: 4960/1200 not seeded" && exit 1)
pass "Sachkonten seeded"

mk_voucher() {
  local number="$1" desc="$2" cc="$3" co="$4"
  local body
  body=$(cat <<JSON
{
  "companyId": "$COMPANY_ID",
  "voucherNumber": "$number",
  "date": "2026-01-15T12:00:00.000Z",
  "description": "$desc",
  "status": "posted",
  "lines": [
    {"accountId":"$SACHKONTO_4960","description":"Bank fee","debit":1.20,"credit":0,"costCenter":"$cc","costObject":"$co"},
    {"accountId":"$SACHKONTO_1200","description":"Bank","debit":0,"credit":1.20,"costCenter":"$cc","costObject":"$co"}
  ]
}
JSON
)
  api_post "/api/v1/accounting/vouchers?companyId=$COMPANY_ID" "$body"
  assert_status "201" "create voucher $number"
}
mk_voucher "Tier50-1" "Tier50 capture test" "VERTRIEB" "PROJ-X"
VOUCHER_ID=$(json_field "$BODY" id)
pass "seeded voucher: $VOUCHER_ID"

# ───── 2. Capture into a template ─────
echo
note "=== 1. POST /voucher-templates/from-voucher/:id ==="
api_post "/api/v1/voucher-templates/from-voucher/$VOUCHER_ID?companyId=$COMPANY_ID" \
  '{"name":"Bank fee template"}'
assert_status "201" "capture returns 201"

TPL_NAME=$(json_field "$BODY" name)
assert_eq "template name" "$TPL_NAME" "Bank fee template"

TPL_DESC=$(json_field "$BODY" description)
assert_eq "description carried" "$TPL_DESC" "Tier50 capture test"

TPL_PATTERN=$(json_field "$BODY" descriptionPattern)
assert_eq "descriptionPattern carried" "$TPL_PATTERN" "Tier50 capture test"

# Inspect the captured linesJson — should have 2
# lines, both with the accountNumber + side + cc/co.
LINES_JSON=$(json_field "$BODY" linesJson)
LINE_COUNT=$(python3 -c "import json,sys;print(len(json.loads(sys.stdin.read())))" <<< "$LINES_JSON")
assert_eq "captured line count" "$LINE_COUNT" "2"

# Line 0 should be the debit (4960) with cc=VERTRIEB
LINE_0=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(json.dumps(d[0]))
" <<< "$LINES_JSON")
LINE_0_ACCT=$(json_field "$LINE_0" accountNumber)
LINE_0_SIDE=$(json_field "$LINE_0" side)
LINE_0_CC=$(json_field "$LINE_0" costCenter)
LINE_0_CO=$(json_field "$LINE_0" costObject)
LINE_0_DESC=$(json_field "$LINE_0" description)
assert_eq "line 0 accountNumber" "$LINE_0_ACCT" "4960"
assert_eq "line 0 side" "$LINE_0_SIDE" "debit"
assert_eq "line 0 costCenter" "$LINE_0_CC" "VERTRIEB"
assert_eq "line 0 costObject" "$LINE_0_CO" "PROJ-X"
assert_eq "line 0 description" "$LINE_0_DESC" "Bank fee"

# Line 1 should be the credit (1200) — note that
# the credit side also has the same cc/co because
# we stamp both lines at create-time.
LINE_1=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(json.dumps(d[1]))
" <<< "$LINES_JSON")
LINE_1_ACCT=$(json_field "$LINE_1" accountNumber)
LINE_1_SIDE=$(json_field "$LINE_1" side)
assert_eq "line 1 accountNumber" "$LINE_1_ACCT" "1200"
assert_eq "line 1 side" "$LINE_1_SIDE" "credit"

# ───── 3. Default name (no body) ─────
echo
note "=== 2. POST capture with no name → default ==="
mk_voucher "Tier50-2" "Tier50 default-name test" "MARKETING" "PROJ-Y"
VOUCHER_ID2=$(json_field "$BODY" id)
api_post "/api/v1/voucher-templates/from-voucher/$VOUCHER_ID2?companyId=$COMPANY_ID" '{}'
assert_status "201" "default-name capture returns 201"
DEFAULT_NAME=$(json_field "$BODY" name)
# Default = "<description> (auto)"
EXPECTED_DEFAULT="Tier50 default-name test (auto)"
assert_eq "default name" "$DEFAULT_NAME" "$EXPECTED_DEFAULT"

# ───── 4. GET /voucher-templates/list-for-apply ─────
echo
note "=== 3. GET /voucher-templates/list-for-apply ==="
api_get "/api/v1/voucher-templates/list-for-apply?companyId=$COMPANY_ID"
assert_status "200" "list-for-apply returns 200"

# 2 templates: Bank fee template + default-name
TPL_COUNT=$(python3 -c "import json,sys;print(len(json.loads(sys.stdin.read())))" <<< "$BODY")
assert_eq "template count" "$TPL_COUNT" "2"

# Each item has `lines` (parsed, not raw linesJson)
FIRST_LINES=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(len(d[0]['lines']))
" <<< "$BODY")
assert_eq "first template lines length" "$FIRST_LINES" "2"

# ───── 5. GET /voucher-templates (existing tier-14 endpoint) still works ─────
echo
note "=== 4. tier-14 list endpoint still works ==="
api_get "/api/v1/voucher-templates?companyId=$COMPANY_ID"
assert_status "200" "tier-14 list returns 200"
LEGACY_COUNT=$(python3 -c "import json,sys;print(len(json.loads(sys.stdin.read())))" <<< "$BODY")
assert_eq "legacy list count" "$LEGACY_COUNT" "2"

# ───── 5b. Apply carries cost-center / cost-object /
# description forward into the resulting draft lines.
# This is the actual user-visible tier-50 payoff:
# one click → all positions pre-filled including
# DATEV stamps + per-line descriptions.
echo
note "=== 4b. Apply carries cc/co/description forward ==="
# Grab the captured template id (first row of list-for-apply)
api_get "/api/v1/voucher-templates/list-for-apply?companyId=$COMPANY_ID"
CAPTURED_ID=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
# pick the one with the canonical name we set above
print(next(t['id'] for t in d if t['name']=='Bank fee template'))
" <<< "$BODY")
pass "captured template id: $CAPTURED_ID"

# Apply with a Betrag
api_post "/api/v1/voucher-templates/$CAPTURED_ID/apply?companyId=$COMPANY_ID" \
  '{"amount":1.20,"date":"2026-01-20T12:00:00.000Z"}'
assert_status "201" "apply returns 201"

# The applied result should have 2 lines, each
# carrying costCenter='VERTRIEB' costObject='PROJ-X'
# description (debit = 'Bank fee', credit = '' since
# capture only stamps debit side from the line's own
# description).
APPLY_LINES=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(len(d['lines']))
" <<< "$BODY")
assert_eq "applied line count" "$APPLY_LINES" "2"

# Debit line (4960) should carry cc=VERTRIEB co=PROJ-X
APPLY_DEBIT_CC=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for l in d['lines']:
    if l['debit']>0:
        print(l.get('costCenter',''))
        break
" <<< "$BODY")
assert_eq "applied debit costCenter" "$APPLY_DEBIT_CC" "VERTRIEB"

APPLY_DEBIT_CO=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for l in d['lines']:
    if l['debit']>0:
        print(l.get('costObject',''))
        break
" <<< "$BODY")
assert_eq "applied debit costObject" "$APPLY_DEBIT_CO" "PROJ-X"

APPLY_DEBIT_DESC=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for l in d['lines']:
    if l['debit']>0:
        print(l.get('description',''))
        break
" <<< "$BODY")
assert_eq "applied debit description" "$APPLY_DEBIT_DESC" "Bank fee"

# ───── 6. Bad inputs ─────
echo
note "=== 5. Bad inputs ==="
api_post "/api/v1/voucher-templates/from-voucher/$VOUCHER_ID" '{}'
assert_status "400" "missing companyId → 400"

# Voucher with <2 lines — seed via SQL (api rejects unbalanced vouch)
THIN_ID=$(uuidgen)
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
INSERT INTO "Voucher" (id, "companyId", "voucherNumber", "date", "description", "status")
VALUES ('$THIN_ID', '$COMPANY_ID', 'Tier50-thin', '2026-01-15', 'Tier50 thin', 'posted');
INSERT INTO "VoucherLine" (id, "voucherId", "accountId", "description", "debit", "credit")
VALUES ('$(uuidgen)', '$THIN_ID', '$SACHKONTO_4960', 'Bank fee', 1.20, 0);
SQL
api_post "/api/v1/voucher-templates/from-voucher/$THIN_ID?companyId=$COMPANY_ID" '{}'
assert_status "400" "voucher <2 lines → 400"

# Non-existent voucher
api_post "/api/v1/voucher-templates/from-voucher/00000000-0000-0000-0000-000000000000?companyId=$COMPANY_ID" '{}'
assert_status "404" "non-existent voucher → 404"

# ───── 7. Cleanup ─────
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "VoucherLine" WHERE "voucherId" IN (
  SELECT id FROM "Voucher" WHERE "companyId" = '$COMPANY_ID' AND "description" LIKE 'Tier50%'
);
DELETE FROM "Voucher"          WHERE "companyId" = '$COMPANY_ID' AND "description" LIKE 'Tier50%';
DELETE FROM "VoucherTemplate" WHERE "companyId" = '$COMPANY_ID' AND (
  "name" LIKE 'Tier50%' OR "description" LIKE 'Tier50%' OR "descriptionPattern" LIKE 'Tier50%'
);
SQL

summary
exit $?