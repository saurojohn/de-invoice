#!/usr/bin/env bash
# e2e 69: Tier 41 — Cost-Center suggestion on Voucher creation.
#
# Validates:
#   1. POST /vouchers accepts per-line costCenter + costObject
#      on the lines[].costCenter / lines[].costObject fields
#      and persists them on VoucherLine.
#   2. GET /vouchers/cost-center-suggestion returns the most-
#      used cost-center pair for the given Sachkonto (sorted
#      by count desc, ties broken by recent).
#   3. GET /vouchers/cost-center-suggestion/list returns the
#      full ranked distinct list (≤ 20 entries).
#   4. Bad inputs: missing companyId / accountId → 400.
#   5. The cost-center-suggestion route is registered BEFORE
#      /vouchers/:id so the literal 'cost-center-suggestion'
#      isn't swallowed by the route param matcher.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

login
cleanup_cashbook
# Wipe Tier-41 fixture Vouchers so the suggestion ranking
# starts fresh.
docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice <<SQL
DELETE FROM "VoucherLine" WHERE "voucherId" IN (SELECT id FROM "Voucher" WHERE "description" LIKE 'Tier41%' AND "companyId" = '$COMPANY_ID');
DELETE FROM "Voucher"     WHERE "description" LIKE 'Tier41%' AND "companyId" = '$COMPANY_ID';
SQL

# Pick Sachkonto 4960 — Sonstige betriebliche Aufwendungen
# (the typical "user books this every month, same cost-center
# each time" case). 4960 ships in the bundled SKR03 chart;
# 4960 was an old label that's been mapped to 4900/4960/4980
# depending on subtype. The behaviour being tested here is
# the *groupBy+history* logic, not the specific account number.
SACHKONTO_4960=$(docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT id FROM \"Account\" WHERE \"companyId\" = '$COMPANY_ID' AND \"accountNumber\" = '4960' LIMIT 1")
COUNTERPART=$(docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT id FROM \"Account\" WHERE \"companyId\" = '$COMPANY_ID' AND \"accountNumber\" = '1200' LIMIT 1")
echo "sachkonto 4960: $SACHKONTO_4960  bank 1200: $COUNTERPART"
[ -n "$SACHKONTO_4960" ] || (echo "FATAL: Sachkonto 4960 not seeded" && exit 1)
[ -n "$COUNTERPART" ] || (echo "FATAL: Sachkonto 1200 not seeded" && exit 1)

mk_voucher() {
  local desc="$1" cc="$2" co="$3" amt="$4"
  local body
  body=$(cat <<JSON
{
  "companyId": "$COMPANY_ID",
  "date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "description": "Tier41 test $desc",
  "status": "posted",
  "lines": [
    {"accountId":"$SACHKONTO_4960","description":"Bank fee","debit":$amt,"credit":0,"costCenter":"$cc","costObject":"$co"},
    {"accountId":"$COUNTERPART","description":"Bank","debit":0,"credit":$amt}
  ]
}
JSON
)
  local outfile="/tmp/t41_voucher_$desc.json"
  curl -sS -o "$outfile" -w "%{http_code}" -X POST \
    "$API/api/v1/accounting/vouchers?companyId=$COMPANY_ID" \
    -H "Content-Type: application/json" \
    -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
    -d "$body" > /tmp/t41_v_${desc}_status.txt
  local s=$(cat /tmp/t41_v_${desc}_status.txt)
  if [ "$s" != "201" ] && [ "$s" != "200" ]; then
    echo "FATAL: voucher create $desc returned $s — $(cat $outfile | head -c 200)"
    exit 1
  fi
}
# 2x Tier41-V100 + Tier41-PQ3 (most-used)
mk_voucher "a" "Tier41-V100" "Tier41-PQ3" "1.20"
mk_voucher "b" "Tier41-V100" "Tier41-PQ3" "0.50"
# 1x Tier41-S200 (less common)
mk_voucher "c" "Tier41-S200" "Tier41-PQ3" "0.80"
echo "  seeded 3 Vouchers on Sachkonto 4960"

# ───── 1. POST /vouchers persisted costCenter on lines ─────
echo
echo "=== 1. POST /vouchers stamped costCenter + costObject on VoucherLine ==="
# Look up the most recent voucher's lines via a fresh GET
# (some services expose GET /vouchers/:id; if not, hit SQL
# directly to verify).
LINE_COUNT_CC=$(docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice -t -A -c \
  "SELECT COUNT(*) FROM \"VoucherLine\" vl JOIN \"Voucher\" v ON v.id = vl.\"voucherId\" WHERE v.\"description\" LIKE 'Tier41%' AND v.\"companyId\" = '$COMPANY_ID' AND vl.\"costCenter\" IS NOT NULL;")
[ "$LINE_COUNT_CC" -eq 3 ] || (echo "FATAL: expected 3 non-null costCenter rows, got $LINE_COUNT_CC" && exit 1)
echo "  3 lines have non-null costCenter ✓"

# ───── 2. GET /cost-center-suggestion returns top-1 ─────
# Use `prefix=Tier41-` to scope the suggest query to our
# test fixtures only. Without the prefix, the suggestion
# would pick up the most-used cost center from ALL of
# the shared DB's prior test runs (PLAY-WRITE from
# Tier 49 etc.) and the test would fail.
echo
echo "=== 2. GET /vouchers/cost-center-suggestion ==="
curl -sS -o /tmp/t41_sug.json -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/vouchers/cost-center-suggestion?companyId=$COMPANY_ID&accountId=$SACHKONTO_4960&prefix=Tier41-" > /dev/null
TOP_CC=$(python3 -c "import json; print(json.load(open('/tmp/t41_sug.json'))['costCenter'])")
TOP_CO=$(python3 -c "import json; print(json.load(open('/tmp/t41_sug.json'))['costObject'])")
TOTAL_LINES=$(python3 -c "import json; print(json.load(open('/tmp/t41_sug.json'))['totalLines'])")
assert_eq "top cc is Tier41-V100" "$TOP_CC" "Tier41-V100"
assert_eq "top co is Tier41-PQ3" "$TOP_CO" "Tier41-PQ3"
[ "$TOTAL_LINES" -eq 3 ] || (echo "FATAL: totalLines expected 3, got $TOTAL_LINES" && exit 1)
echo "  top: Tier41-V100 / Tier41-PQ3 (3 lines) ✓"

# ───── 3. GET /cost-center-suggestion/list returns ranked distinct list ─────
# Same `prefix=Tier41-` scope as the suggest endpoint.
echo
echo "=== 3. GET /vouchers/cost-center-suggestion/list ==="
curl -sS -o /tmp/t41_list.json -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/vouchers/cost-center-suggestion/list?companyId=$COMPANY_ID&accountId=$SACHKONTO_4960&prefix=Tier41-" > /dev/null
TOP_COUNT=$(python3 -c "import json; print(json.load(open('/tmp/t41_list.json'))['items'][0]['count'])")
TOP_CC=$(python3 -c "import json; print(json.load(open('/tmp/t41_list.json'))['items'][0]['costCenter'])")
SECOND_CC=$(python3 -c "import json; print(json.load(open('/tmp/t41_list.json'))['items'][1]['costCenter'])")
SECOND_COUNT=$(python3 -c "import json; print(json.load(open('/tmp/t41_list.json'))['items'][1]['count'])")
assert_eq "list[0] cc Tier41-V100" "$TOP_CC" "Tier41-V100"
[ "$TOP_COUNT" -eq 2 ] || (echo "FATAL: list[0].count expected 2, got $TOP_COUNT" && exit 1)
assert_eq "list[1] cc Tier41-S200" "$SECOND_CC" "Tier41-S200"
[ "$SECOND_COUNT" -eq 1 ] || (echo "FATAL: list[1].count expected 1, got $SECOND_COUNT" && exit 1)
echo "  list[0]: Tier41-V100 (×2)  list[1]: Tier41-S200 (×1) ✓"

# ───── 4. Bad inputs ─────
echo
echo "=== 4. Bad inputs ==="
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/vouchers/cost-center-suggestion?accountId=$SACHKONTO_4960")
assert_eq "missing companyId → 400" "$STATUS" "400"
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/vouchers/cost-center-suggestion?companyId=$COMPANY_ID")
assert_eq "missing accountId → 400" "$STATUS" "400"

# ───── 5. /vouchers/:id route precedence ─────
echo
echo "=== 5. /vouchers/cost-center-suggestion isn't swallowed by /vouchers/:id ==="
# If the controller parsed 'cost-center-suggestion' as :id
# it would 500 (Prisma can't find a UUID). We expect 400
# instead, which proves the dedicated route intercepted
# the request. Pass an obviously-not-UUID accountId so
# the suggest path returns 400 due to its own validation,
# not 404.
STATUS=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" \
  "$API/api/v1/accounting/vouchers/cost-center-suggestion?companyId=$COMPANY_ID&accountId=not-a-uuid")
[ "$STATUS" = "400" ] || [ "$STATUS" = "200" ] || (echo "FATAL: expected 400/200, got $STATUS — likely /:id swallowed it" && exit 1)
echo "  suggest route still reachable (HTTP $STATUS) ✓"

# ───── Cleanup ─────
docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice <<SQL
DELETE FROM "VoucherLine" WHERE "voucherId" IN (SELECT id FROM "Voucher" WHERE "description" LIKE 'Tier41%' AND "companyId" = '$COMPANY_ID');
DELETE FROM "Voucher"     WHERE "description" LIKE 'Tier41%' AND "companyId" = '$COMPANY_ID';
SQL

summary "Tier N"
