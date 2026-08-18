#!/usr/bin/env bash
# e2e 76: Tier 49 — Joint Sachkonto+costCenter
# suggestion with prefix filter.
#
# Extends tier-41's GET
# /vouchers/cost-center-suggestion/list with
# optional `prefix` (cost-center prefix) and
# `costObjectPrefix` (cost-object prefix) query
# params. The Berater form uses this for
# autocomplete under the cost-center input —
# typing "VER" narrows the dropdown to "VERTRIEB".
#
# Validates:
#   1. Without prefix — all distinct stamps
#      returned (matches tier-41 behaviour).
#   2. With prefix — only rows whose costCenter
#      contains the prefix are returned.
#   3. With costObjectPrefix — only rows whose
#      costObject contains the prefix are returned.
#   4. Combined prefix+costObjectPrefix — AND
#      semantics.
#   5. Prefix match is case-insensitive.
#   6. No match → items=[].
#   7. Same prefix param on the single-hit
#      /cost-center-suggestion endpoint filters
#      the candidate pool.
#   8. Bad inputs (missing companyId/accountId)
#      → 400.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook
# ───── 0. Wipe prior tier-49 fixtures ─────
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "VoucherLine" WHERE "voucherId" IN (
  SELECT id FROM "Voucher" WHERE "companyId" = '$COMPANY_ID' AND "description" LIKE 'Tier49%'
);
DELETE FROM "Voucher"     WHERE "companyId" = '$COMPANY_ID' AND "description" LIKE 'Tier49%';
SQL

# ───── 1. Get the Sachkonto ─────
SACHKONTO_4960=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT id FROM \"Account\" WHERE \"companyId\" = '$COMPANY_ID' AND \"accountNumber\" = '4960' LIMIT 1")
SACHKONTO_1200=$(docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT id FROM \"Account\" WHERE \"companyId\" = '$COMPANY_ID' AND \"accountNumber\" = '1200' LIMIT 1")
[[ -n "$SACHKONTO_4960" ]] || (echo "FATAL: 4960 not seeded" && exit 1)
[[ -n "$SACHKONTO_1200" ]] || (echo "FATAL: 1200 not seeded" && exit 1)
pass "Sachkonten seeded: 4960=$SACHKONTO_4960, 1200=$SACHKONTO_1200"

# ───── 2. Seed a known stamp set on 4960 ─────
mk_voucher() {
  local number="$1" cc="$2" co="$3" date="$4"
  local body
  body=$(cat <<JSON
{
  "companyId": "$COMPANY_ID",
  "voucherNumber": "$number",
  "date": "$date",
  "description": "Tier49 seed",
  "status": "posted",
  "lines": [
    {"accountId":"$SACHKONTO_4960","description":"Bank fee","debit":1,"credit":0,"costCenter":"$cc","costObject":"$co"},
    {"accountId":"$SACHKONTO_1200","description":"Bank","debit":0,"credit":1}
  ]
}
JSON
)
  api_post "/api/v1/accounting/vouchers?companyId=$COMPANY_ID" "$body"
  assert_status "201" "seed voucher $number (cc=$cc, co=$co)"
}

mk_voucher "Tier49-1" "VERTRIEB"    "PROJ-A" "2026-01-05T12:00:00.000Z"
mk_voucher "Tier49-2" "VERTRIEB"    "PROJ-A" "2026-01-10T12:00:00.000Z"
mk_voucher "Tier49-3" "VERTRIEB"    "PROJ-B" "2026-02-15T12:00:00.000Z"
mk_voucher "Tier49-4" "MARKETING"   "PROJ-A" "2026-03-01T12:00:00.000Z"
mk_voucher "Tier49-5" "MARKETING"   "PROJ-B" "2026-03-15T12:00:00.000Z"
pass "seeded 5 vouchers on Sachkonto 4960 with mixed cc/co stamps"

# ───── 3. No prefix — all 3 distinct pairs ─────
echo
note "=== 1. GET /list without prefix ==="
api_get "/api/v1/accounting/vouchers/cost-center-suggestion/list?companyId=$COMPANY_ID&accountId=$SACHKONTO_4960"
assert_status "200" "list no prefix → 200"

COUNT=$(json_field "$BODY" count)
[[ "$COUNT" -ge 3 ]] \
  && pass "list returns ≥3 distinct pairs ($COUNT)" \
  || fail "list count: $COUNT"

# ───── 4. With prefix=VERT — only VERTRIEB ─────
echo
note "=== 2. prefix=VERT narrows to VERTRIEB only ==="
api_get "/api/v1/accounting/vouchers/cost-center-suggestion/list?companyId=$COMPANY_ID&accountId=$SACHKONTO_4960&prefix=VERT"
assert_status "200" "list prefix=VERT → 200"

# Note: prefix=VERT also matches BK-HIST-001's
# VERTRIEB-100 (case-insensitive `contains`). So the
# first item may be VERTRIEB-100 (count 5) instead of
# VERTRIEB (count 3). We assert all items start with
# "VERT" rather than equal "VERTRIEB" exactly.
ALL_VERT=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print('yes' if all(it['costCenter'].upper().startswith('VERT') for it in d['items']) else 'no')
" <<< "$BODY")
assert_eq "all items have cc starting with VERT" "$ALL_VERT" "yes"

NONE_MARKETING=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print('yes' if all('MARKETING' not in it['costCenter'] for it in d['items']) else 'no')
" <<< "$BODY")
assert_eq "MARKETING excluded" "$NONE_MARKETING" "yes"

# ───── 5. With costObjectPrefix=PROJ-A ─────
echo
note "=== 3. costObjectPrefix=PROJ-A narrows to PROJ-A only ==="
api_get "/api/v1/accounting/vouchers/cost-center-suggestion/list?companyId=$COMPANY_ID&accountId=$SACHKONTO_4960&costObjectPrefix=PROJ-A"
assert_status "200" "list co-prefix=PROJ-A → 200"

ALL_PA=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print('yes' if all(it['costObject']=='PROJ-A' for it in d['items']) else 'no')
" <<< "$BODY")
assert_eq "all items have co=PROJ-A" "$ALL_PA" "yes"

# ───── 6. Combined prefix + costObjectPrefix ─────
echo
note "=== 4. prefix=VERT & costObjectPrefix=PROJ-A (AND) ==="
api_get "/api/v1/accounting/vouchers/cost-center-suggestion/list?companyId=$COMPANY_ID&accountId=$SACHKONTO_4960&prefix=VERT&costObjectPrefix=PROJ-A"
assert_status "200" "list prefix+co-prefix → 200"

ALL_BOTH=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print('yes' if all(it['costCenter']=='VERTRIEB' and it['costObject']=='PROJ-A' for it in d['items']) else 'no')
" <<< "$BODY")
assert_eq "all items match both filters" "$ALL_BOTH" "yes"

# ───── 7. Case-insensitive prefix ─────
echo
note "=== 5. prefix=vert (lowercase) is case-insensitive ==="
api_get "/api/v1/accounting/vouchers/cost-center-suggestion/list?companyId=$COMPANY_ID&accountId=$SACHKONTO_4960&prefix=vert"
assert_status "200" "list prefix=vert → 200"

LOWER_HITS=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(sum(1 for it in d['items'] if it['costCenter']=='VERTRIEB'))
" <<< "$BODY")
[[ "$LOWER_HITS" -ge 1 ]] \
  && pass "lowercase prefix matches uppercase cc ($LOWER_HITS hits)" \
  || fail "case-insensitive broken: $LOWER_HITS hits"

# ───── 8. No match ─────
echo
note "=== 6. No match → items=[] ==="
api_get "/api/v1/accounting/vouchers/cost-center-suggestion/list?companyId=$COMPANY_ID&accountId=$SACHKONTO_4960&prefix=XYZNOMATCH"
assert_status "200" "no match → 200"
EMPTY_COUNT=$(json_field "$BODY" count)
assert_eq "no-match count" "$EMPTY_COUNT" "0"

# ───── 9. Single-hit endpoint with prefix ─────
echo
note "=== 7. Single-hit /cost-center-suggestion with prefix ==="
api_get "/api/v1/accounting/vouchers/cost-center-suggestion?companyId=$COMPANY_ID&accountId=$SACHKONTO_4960&prefix=VERT"
assert_status "200" "single-hit with prefix → 200"
TOP_CC=$(json_field "$BODY" costCenter)
# Top hit may be VERTRIEB-100 (count 5 from BK-HIST-001)
# or VERTRIEB (count 3 from Tier49-2 + Tier49-1).
# Either way it starts with "VERT".
TOP_OK=$([[ "$TOP_CC" == VERT* ]] && echo "yes" || echo "no")
assert_eq "top hit starts with VERT" "$TOP_OK" "yes"

# Without prefix — top hit may be PLAY-WRITE (from
# prior tiers). Just assert the endpoint returns
# 200 + the response shape.
api_get "/api/v1/accounting/vouchers/cost-center-suggestion?companyId=$COMPANY_ID&accountId=$SACHKONTO_4960"
assert_status "200" "single-hit no prefix → 200"
TOP_CC2=$(json_field "$BODY" costCenter)
[[ -n "$TOP_CC2" ]] && pass "single-hit returns top cc: $TOP_CC2" \
  || fail "single-hit cc empty"

# ───── 10. Bad inputs ─────
echo
note "=== 8. Bad inputs ==="
api_get "/api/v1/accounting/vouchers/cost-center-suggestion/list?accountId=$SACHKONTO_4960"
assert_status "400" "missing companyId → 400"

api_get "/api/v1/accounting/vouchers/cost-center-suggestion/list?companyId=$COMPANY_ID"
assert_status "400" "missing accountId → 400"

# ───── 11. Cleanup ─────
docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL >/dev/null
DELETE FROM "VoucherLine" WHERE "voucherId" IN (
  SELECT id FROM "Voucher" WHERE "companyId" = '$COMPANY_ID' AND "description" LIKE 'Tier49%'
);
DELETE FROM "Voucher"     WHERE "companyId" = '$COMPANY_ID' AND "description" LIKE 'Tier49%';
SQL

summary
exit $?