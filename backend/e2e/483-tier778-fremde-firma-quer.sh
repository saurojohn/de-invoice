#!/bin/bash
# Tier 778 — what one company can still reach of another, found by a sweep
#
# A sweep called every route that takes an id (of 537 routes; 470 calls with
# another company's ids in the path, then B's own record in the path with the
# other company's ids in the child path and the body, then one foreign body
# field at a time; every GET as an empty company, each UUID of the answer
# looked up) and read the database after each call. Everything was refused
# except:
#   POST /assets/_test/auto-booker-trigger  booked the AfA of EVERY open company
#     (2 795 in the test database), for any company admin on a non-production
#     install; the audit row of each booking went into the CALLER's trail —
#     another company's asset, amount and id, which the caller then read in
#     /audit-logs, its CSV export and its GoBD archive — and the answer named
#     other companies under `errors`
#   POST /accounting/accounts  took parentId as sent: an account of another
#     company was accepted, the new account hung in that company's chart
#   PUT /products/:id: categoryId was looked up by id alone (another company's
#     category accepted, its name copied into the product); an unknown one was a 500
#   POST /accounting/accounts with a number the company has: 500 (P2002), and
#     an empty parentId was stored as the empty string
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-483-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
company() { # suffix → U C
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier778-e2e\",\"companyName\":\"$TAG $1 GmbH\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}

company a; UA=$U; CA=$C
company b; UB=$U; CB=$C
[[ -n "${CA:-}" && -n "${CB:-}" ]] && pass "fixture: companies A and B" || { fail "register"; summary; exit 1; }
ASSET=$(q "insert into \"Asset\" (id, \"companyId\", type, bezeichnung, \"anschaffungsDatum\", \"anschaffungsKosten\", \"nutzungsdauerMonate\", restwert, \"afaMethode\", \"bilanzKonto\", \"createdAt\", \"updatedAt\")
  values (gen_random_uuid()::text, '$CA', 'Maschine', '$TAG Presse', '2030-01-01', 6000, 60, 0, 'linear', '0300', now(), now()) returning id" | head -1)
ACC_A=$(q "insert into \"Account\" (id, \"companyId\", \"accountNumber\", name, type) values (gen_random_uuid()::text, '$CA', '9911', '$TAG Kasse A', 'asset') returning id" | head -1)
CAT_A=$(q "insert into \"Category\" (id, \"companyId\", name) values (gen_random_uuid()::text, '$CA', '$TAG Geheimsortiment') returning id" | head -1)
[[ -n "$ASSET" && -n "$ACC_A" && -n "$CAT_A" ]] && pass "fixture: A has an asset, an account and a product category" || fail "fixture of A"

note "=== 1. the AfA test trigger books the caller's company only ==="
U=$UB; C=$CB
AS POST "/api/v1/assets/_test/auto-booker-trigger?year=2030"
assert_status 201 "B triggers the AfA booking"
assert_eq "…for one company (was every open company)" "$(json_field "$BODY" companies)" "1"
assert_eq "A's asset is not booked by B (was 12 monthly rows)" "$(q "select count(*) from \"Expense\" where \"relatedAssetId\" = '$ASSET'")" "0"
assert_eq "B's audit trail holds nothing of A (was one expense.created row per booking)" \
  "$(q "select count(*) from \"AuditLog\" where \"companyId\" = '$CB' and (\"newData\"::text like '%$ASSET%' or \"newData\"::text like '%$CA%')")" "0"
[[ "$BODY" != *"$TAG a GmbH"* ]] && pass "…and the answer names no other company" || fail "the answer names A: ${BODY:0:200}"
U=$UA; C=$CA
AS POST "/api/v1/assets/_test/auto-booker-trigger?year=2030"
assert_status 201 "A triggers it"
assert_eq "…and A's asset gets its 12 monthly AfA rows" "$(q "select count(*) from \"Expense\" where \"relatedAssetId\" = '$ASSET' and category = 'AfA'")" "12"
assert_eq "…whose audit rows are in A's trail" "$(q "select count(*) from \"AuditLog\" where \"companyId\" = '$CA' and action = 'expense.created' and \"newData\"::text like '%$ASSET%'")" "12"

note "=== 2. the parent of an account is an account of the same company ==="
U=$UB; C=$CB
AS POST "/api/v1/accounting/accounts?companyId=$CB" "{\"accountNumber\":\"9922\",\"name\":\"$TAG unter A\",\"type\":\"asset\",\"parentId\":\"$ACC_A\"}"
assert_status 400 "B files an account under A's account (was 201)"
assert_eq "…the message says why" "$(json_field "$BODY" message)" "Das übergeordnete Konto gibt es in dieser Firma nicht."
assert_eq "A's account has no child from B" "$(q "select count(*) from \"Account\" where \"parentId\" = '$ACC_A'")" "0"
AS POST "/api/v1/accounting/accounts?companyId=$CB" "{\"accountNumber\":\"9922\",\"name\":\"$TAG Oberkonto B\",\"type\":\"asset\"}"
assert_status 201 "B creates an account of its own"
PARENT_B=$(json_field "$BODY" id)
AS POST "/api/v1/accounting/accounts?companyId=$CB" "{\"accountNumber\":\"9923\",\"name\":\"$TAG Unterkonto B\",\"type\":\"asset\",\"parentId\":\"$PARENT_B\"}"
assert_status 201 "…and one under it"
assert_eq "…which hangs under B's account" "$(json_field "$BODY" parentId)" "$PARENT_B"
AS POST "/api/v1/accounting/accounts?companyId=$CB" "{\"accountNumber\":\"9922\",\"name\":\"$TAG noch einmal\",\"type\":\"asset\"}"
assert_status 409 "a number the company has (was 500 'Resource already exists')"
assert_eq "…the message names it" "$(json_field "$BODY" message)" "Das Konto 9922 gibt es in dieser Firma schon."
AS POST "/api/v1/accounting/accounts?companyId=$CB" "{\"accountNumber\":\"9911\",\"name\":\"$TAG wie bei A\",\"type\":\"asset\"}"
assert_status 201 "the number of another company's account is free in B"
AS POST "/api/v1/accounting/accounts?companyId=$CB" "{\"accountNumber\":\"9924\",\"name\":\"$TAG ohne Oberkonto\",\"type\":\"asset\",\"parentId\":\"\"}"
assert_status 201 "an empty parent is no parent"
assert_eq "…stored as none (was the empty string)" "$(q "select coalesce(\"parentId\", 'NULL') from \"Account\" where \"companyId\" = '$CB' and \"accountNumber\" = '9924'")" "NULL"

note "=== 3. a product's category is one of the company's ==="
AS POST "/api/v1/products?companyId=$CB" "{\"name\":\"$TAG Produkt\",\"basePrice\":5,\"categoryId\":\"$CAT_A\"}"
assert_status 400 "a new product takes no category (the create body has none)"
AS POST "/api/v1/products?companyId=$CB" "{\"name\":\"$TAG Produkt\",\"basePrice\":5}"
assert_status 201 "B creates the product without a category"
PROD=$(json_field "$BODY" id)
AS PUT "/api/v1/products/$PROD?companyId=$CB" "{\"categoryId\":\"$CAT_A\"}"
assert_status 400 "…and cannot move it into A's category (was 200)"
[[ "$BODY" != *"Geheimsortiment"* ]] && pass "…nor learn its name (was copied into categoryName)" || fail "A's category name: ${BODY:0:200}"
AS PUT "/api/v1/products/$PROD?companyId=$CB" "{\"categoryId\":\"$(python3 -c 'import uuid;print(uuid.uuid4())')\"}"
assert_status 400 "an unknown category (was 500 'Related resource not found')"
assert_eq "…the message says which" "$(json_field "$BODY" message)" "Kategorie nicht gefunden"
assert_eq "the product is still without a category" "$(q "select coalesce(\"categoryId\",'-')||'/'||coalesce(\"categoryName\",'') from \"Product\" where id = '$PROD'")" "-/"
CAT_B=$(q "insert into \"Category\" (id, \"companyId\", name) values (gen_random_uuid()::text, '$CB', '$TAG Eigenes Sortiment') returning id" | head -1)
AS PUT "/api/v1/products/$PROD?companyId=$CB" "{\"categoryId\":\"$CAT_B\"}"
assert_status 200 "B files it under its own category"
assert_eq "…whose name the product carries" "$(json_field "$BODY" categoryName)" "$TAG Eigenes Sortiment"

summary
