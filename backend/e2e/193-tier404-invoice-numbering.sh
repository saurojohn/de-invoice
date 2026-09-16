#!/bin/bash
# Tier 404 — invoice numbers are per company, not per platform
#
# Measured before the fix, two fresh companies on a throwaway stack:
#   A: INV-2026-000001
#   B: INV-2026-000002
#   B: INV-2026-000003
#   B: INV-2026-000004
#   A: INV-2026-000005
# Tier 174 made numbering atomic with a Postgres SEQUENCE per (type, year), but
# the sequence was shared by every tenant and @@unique([companyId,
# invoiceNumber]) hid the consequence: company A's books jump from 1 to 5. Each
# gap is another tenant's invoice, so A can read off B's invoice volume, and in
# a Betriebsprüfung the operator must explain gaps in a *fortlaufende* Nummer
# (§ 14 Abs. 4 Nr. 4 UStG) using data they are not allowed to show.
#
# Existing numbers are never rewritten (GoBD § 146): a company's new sequence
# starts above the highest number it already used for that type and year.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-193-$(date +%s%N | cut -c1-13)"
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null; }

mkco() { # suffix → "userId companyId"
  curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier404-e2e\",\"companyName\":\"$TAG $1\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null
}
AS() { # user company method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$3" "$API$4" -H "x-user-id: $1" -H "x-company-id: $2" \
    -H "Content-Type: application/json" ${5:+-d "$5"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
ITEM='{"description":"Leistung","quantity":1,"unit":"Stk","unitPrice":100,"vatRate":0.19}'
newinv() { # user company customer → prints the number
  AS "$1" "$2" POST "/api/v1/invoices?companyId=$2" \
    "{\"customerId\":\"$3\",\"issueDate\":\"2026-09-01\",\"items\":[$ITEM]}"
  json_field "$BODY" invoiceNumber
}

read -r UA CA < <(mkco a)
read -r UB CB < <(mkco b)
[[ -n "${CA:-}" && -n "${CB:-}" ]] && pass "fixture: two fresh companies" || { fail "register"; summary; exit 1; }
AS "$UA" "$CA" POST "/api/v1/customers?companyId=$CA" "{\"name\":\"$TAG A\",\"type\":\"business\"}"; KA=$(json_field "$BODY" id)
AS "$UB" "$CB" POST "/api/v1/customers?companyId=$CB" "{\"name\":\"$TAG B\",\"type\":\"business\"}"; KB=$(json_field "$BODY" id)

note "=== 1. each company numbers from its own 1, whatever the other does ==="
A1=$(newinv "$UA" "$CA" "$KA")
B1=$(newinv "$UB" "$CB" "$KB")
B2=$(newinv "$UB" "$CB" "$KB")
B3=$(newinv "$UB" "$CB" "$KB")
A2=$(newinv "$UA" "$CA" "$KA")
assert_eq "A's first invoice" "$A1" "INV-2026-000001"
assert_eq "B's first invoice is also 1 (was 2 — it continued A's series)" "$B1" "INV-2026-000001"
assert_eq "B's second" "$B2" "INV-2026-000002"
assert_eq "B's third" "$B3" "INV-2026-000003"
assert_eq "A's second is 2, not 5 — no gap from B's three invoices" "$A2" "INV-2026-000002"

note "=== 2. credit notes get their own series, also per company ==="
AS "$UA" "$CA" POST "/api/v1/invoices?companyId=$CA" \
  "{\"customerId\":\"$KA\",\"type\":\"CN\",\"issueDate\":\"2026-09-01\",\"items\":[$ITEM]}"
CN_A=$(json_field "$BODY" invoiceNumber)
AS "$UB" "$CB" POST "/api/v1/invoices?companyId=$CB" \
  "{\"customerId\":\"$KB\",\"type\":\"CN\",\"issueDate\":\"2026-09-01\",\"items\":[$ITEM]}"
CN_B=$(json_field "$BODY" invoiceNumber)
assert_eq "A's first credit note" "$CN_A" "CN-2026-000001"
assert_eq "B's first credit note (was 2)" "$CN_B" "CN-2026-000001"
assert_eq "…and the INV series is untouched by it" "$(newinv "$UA" "$CA" "$KA")" "INV-2026-000003"

note "=== 3. a company that already has invoices continues above its own max ==="
# The seed company has thousands of rows from earlier specs. Nothing may be
# renumbered or reused — GoBD § 146 forbids altering a booked document.
MAX_BEFORE=$(sql "SELECT COALESCE(MAX(CAST(SUBSTRING(\"invoiceNumber\" FROM '([0-9]+)\$') AS BIGINT)), 0)
                  FROM \"Invoice\" WHERE \"companyId\" = '$COMPANY_ID' AND \"invoiceNumber\" LIKE 'INV-2026-%';")
api_post "/api/v1/customers?companyId=$COMPANY_ID" "{\"name\":\"$TAG seed\",\"type\":\"business\"}"
KS=$(json_field "$BODY" id)
NEXT=$(newinv "$USER_ID" "$COMPANY_ID" "$KS")
assert_eq "the next number is max+1" "$NEXT" "INV-2026-$(printf '%06d' $((MAX_BEFORE + 1)))"
assert_eq "…and no earlier number was reused" \
  "$(sql "SELECT count(*) FROM (SELECT \"invoiceNumber\" FROM \"Invoice\" WHERE \"companyId\" = '$COMPANY_ID' GROUP BY \"invoiceNumber\" HAVING count(*) > 1) d;")" "0"

note "=== 4. concurrent creates still get distinct, contiguous numbers ==="
# Tier 174's original problem. The per-company sequence must not reintroduce it.
BEFORE=$(sql "SELECT COALESCE(MAX(CAST(SUBSTRING(\"invoiceNumber\" FROM '([0-9]+)\$') AS BIGINT)), 0)
              FROM \"Invoice\" WHERE \"companyId\" = '$CA' AND \"invoiceNumber\" LIKE 'INV-2026-%';")
OUT="$SCRIPT_DIR/../.t193-concurrent"
: > "$OUT"
for _ in $(seq 1 8); do newinv "$UA" "$CA" "$KA" >> "$OUT" & done
wait
COUNT=$(grep -c . "$OUT"); DISTINCT=$(sort -u "$OUT" | grep -c .)
assert_eq "8 parallel creates produced 8 numbers" "$COUNT" "8"
assert_eq "…all distinct" "$DISTINCT" "8"
AFTER=$(sql "SELECT COALESCE(MAX(CAST(SUBSTRING(\"invoiceNumber\" FROM '([0-9]+)\$') AS BIGINT)), 0)
             FROM \"Invoice\" WHERE \"companyId\" = '$CA' AND \"invoiceNumber\" LIKE 'INV-2026-%';")
assert_eq "…and contiguous: max advanced by exactly 8" "$((AFTER - BEFORE))" "8"
rm -f "$OUT"

note "=== 5. a sequence that fell behind repairs itself instead of 500ing ==="
# Measured on the old code: rewind the sequence so it hands out a number the
# company already used, and the create answers `500 Internal server error` —
# the P2002 from @@unique([companyId, invoiceNumber]) was never caught. A
# restore or a direct insert can still put a sequence behind, so the numbering
# fast-forwards past the company's max rather than failing the request.
SEQ_NAME=$(sql "SELECT relname FROM pg_class WHERE relkind = 'S'
                AND relname = 'invoice_seq_inv_2026_' || replace('$CB', '-', '');")
[[ -n "$SEQ_NAME" ]] && pass "B has its own sequence: $SEQ_NAME" || fail "no per-company sequence for B"
sql "SELECT setval('$SEQ_NAME', 1, true);" >/dev/null
RECOVERED=$(newinv "$UB" "$CB" "$KB")
assert_status 201 "the create succeeds (was 500)"
B_MAX=$(sql "SELECT COALESCE(MAX(CAST(SUBSTRING(\"invoiceNumber\" FROM '([0-9]+)$') AS BIGINT)), 0)
             FROM \"Invoice\" WHERE \"companyId\" = '$CB' AND \"invoiceNumber\" LIKE 'INV-2026-%';")
assert_eq "…with a number past the company's own max" "$RECOVERED" "INV-2026-$(printf '%06d' "$B_MAX")"
assert_eq "…and nothing was reused" \
  "$(sql "SELECT count(*) FROM (SELECT \"invoiceNumber\" FROM \"Invoice\" WHERE \"companyId\" = '$CB' GROUP BY \"invoiceNumber\" HAVING count(*) > 1) d;")" "0"

note "=== 6. the recurring path numbers from the same series ==="
# It had its own copy of the numbering code, with a comment asking that the two
# stay in sync. It used the shared sequence, so a recurring run punched a gap
# into every other company's books.
AS "$UB" "$CB" POST "/api/v1/recurring-invoices?companyId=$CB" \
  "{\"name\":\"$TAG monthly\",\"customerId\":\"$KB\",\"interval\":\"monthly\",\"startDate\":\"2026-08-19\",\"items\":[{\"description\":\"Hosting\",\"quantity\":1,\"unitPrice\":100,\"vatRate\":0.19}],\"sendEmail\":false}"
TPL=$(json_field "$BODY" id)
[[ -n "$TPL" ]] && pass "fixture: a recurring template for B" || fail "template: $BODY"
B_BEFORE=$(sql "SELECT COALESCE(MAX(CAST(SUBSTRING(\"invoiceNumber\" FROM '([0-9]+)\$') AS BIGINT)), 0)
                FROM \"Invoice\" WHERE \"companyId\" = '$CB' AND \"invoiceNumber\" LIKE 'INV-2026-%';")
A_BEFORE=$(sql "SELECT COALESCE(MAX(CAST(SUBSTRING(\"invoiceNumber\" FROM '([0-9]+)\$') AS BIGINT)), 0)
                FROM \"Invoice\" WHERE \"companyId\" = '$CA' AND \"invoiceNumber\" LIKE 'INV-2026-%';")
AS "$UB" "$CB" POST "/api/v1/recurring-invoices/$TPL/run?companyId=$CB" "{}"
assert_status 201 "the recurring run fires"
B_AFTER=$(sql "SELECT COALESCE(MAX(CAST(SUBSTRING(\"invoiceNumber\" FROM '([0-9]+)\$') AS BIGINT)), 0)
               FROM \"Invoice\" WHERE \"companyId\" = '$CB' AND \"invoiceNumber\" LIKE 'INV-2026-%';")
assert_eq "…and takes B's next number" "$((B_AFTER - B_BEFORE))" "1"
assert_eq "…without moving A's series" "$(newinv "$UA" "$CA" "$KA")" \
  "INV-2026-$(printf '%06d' $((A_BEFORE + 1)))"

summary; exit $?
