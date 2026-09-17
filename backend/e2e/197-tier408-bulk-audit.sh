#!/bin/bash
# Tier 408 — a bulk write is on the record per record, not as a count
#
# updateMany / deleteMany used to leave a single row: entityId `bulk:<where>`,
# newData `{ count }`. Measured on a customer merge: both invoices moved to the
# other customer, each invoice's own trail still read only `invoice.created`,
# and one row said "2 invoices of customer A were updated" — not which, and not
# to what. It also wrote six `{ count: 0 }` rows for relations the customer did
# not have. The same shape covered an invoice's items deleted with it, the AfA
# storno deleting booked expenses, and a SEPA batch marking invoices paid.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-197-$(date +%s%N | cut -c1-13)"
TODAY=$(date +%F)
YEAR=$(date +%Y)
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier408-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
cust() { AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$1\",\"type\":\"business\"}"; json_field "$BODY" id; }
inv() { # customer price
  AS POST "/api/v1/invoices?companyId=$C" \
    "{\"customerId\":\"$1\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":0.19}]}"
  json_field "$BODY" id
}

note "=== 1. a customer merge: every moved invoice records the move ==="
SRC=$(cust "$TAG Alt"); TGT=$(cust "$TAG Neu")
I1=$(inv "$SRC" 100); I2=$(inv "$SRC" 200)
AS POST "/api/v1/customers/merge?companyId=$C" "{\"sourceId\":\"$SRC\",\"targetId\":\"$TGT\"}"
assert_status 200 "the merge"
for I in "$I1" "$I2"; do
  assert_eq "invoice ${I:0:8}: its own trail shows source → target (was: nothing)" \
    "$(sql "SELECT (\"oldData\"->>'customerId') || '>' || (\"newData\"->>'customerId') FROM \"AuditLog\" WHERE \"entityId\" = '$I' AND action = 'invoice.updated' ORDER BY seq DESC LIMIT 1;")" \
    "$SRC>$TGT"
done
# The merge runs in a transaction; an after-image read before commit would still
# show the source customer. Seeing the target proves it was read afterwards.
assert_eq "…the after-image is the committed state" \
  "$(sql "SELECT count(*) FROM \"AuditLog\" WHERE \"entityId\" IN ('$I1','$I2') AND action = 'invoice.updated' AND \"newData\"->>'customerId' = '$SRC';")" "0"
assert_eq "…attributed to the user who merged" \
  "$(sql "SELECT count(DISTINCT \"userId\") FROM \"AuditLog\" WHERE \"entityId\" IN ('$I1','$I2') AND action = 'invoice.updated';")" "1"
assert_eq "no count-only rows (was: one per relation, most with count 0)" \
  "$(sql "SELECT count(*) FROM \"AuditLog\" WHERE \"companyId\" = '$C' AND \"entityId\" LIKE 'bulk:%';")" "0"

note "=== 2. deleting an invoice records each of its items ==="
AS POST "/api/v1/invoices?companyId=$C" \
  "{\"customerId\":\"$TGT\",\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"$TAG Pos A\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":10,\"vatRate\":0.19},{\"description\":\"$TAG Pos B\",\"quantity\":2,\"unit\":\"Stk\",\"unitPrice\":5,\"vatRate\":0.19}]}"
D=$(json_field "$BODY" id)
AS DELETE "/api/v1/invoices/$D?companyId=$C"
assert_status 200 "the draft is deleted"
assert_eq "both items are on the record, with their content" \
  "$(sql "SELECT string_agg(\"oldData\"->>'description', ',' ORDER BY \"oldData\"->>'description') FROM \"AuditLog\" WHERE action = 'invoiceitem.deleted' AND \"oldData\"->>'invoiceId' = '$D';")" \
  "$TAG Pos A,$TAG Pos B"

note "=== 3. the AfA storno records each booking it removes ==="
sql "INSERT INTO \"Asset\" (id, \"companyId\", type, bezeichnung, \"anschaffungsDatum\", \"anschaffungsKosten\", \"nutzungsdauerMonate\", restwert, \"afaMethode\", \"bilanzKonto\", \"createdAt\", \"updatedAt\")
     VALUES (gen_random_uuid()::text, '$C', 'Maschine', '$TAG Maschine', '$YEAR-01-01', 6000, 60, 0, 'linear', '0300', now(), now());" >/dev/null
ASSET=$(sql "SELECT id FROM \"Asset\" WHERE \"companyId\" = '$C' AND bezeichnung = '$TAG Maschine';")
AS POST "/api/v1/assets/book-afa?companyId=$C&year=$YEAR"
EXP=$(sql "SELECT id FROM \"Expense\" WHERE \"relatedAssetId\" = '$ASSET' AND category = 'AfA' LIMIT 1;")
[[ -n "$EXP" ]] && pass "fixture: a booked AfA expense" || fail "book-afa booked nothing: $BODY"
AS POST "/api/v1/assets/storno-afa?companyId=$C&year=$YEAR"
assert_eq "the storno removed it" "$(json_field "$BODY" stornoedCount)" "1"
assert_eq "the removed booking is on the record under its own id (was: a count)" \
  "$(sql "SELECT count(*) FROM \"AuditLog\" WHERE \"entityId\" = '$EXP' AND action = 'expense.deleted';")" "1"
# AfA bookings are stored negative (-1200); the storno reports the absolute value.
assert_eq "…with its amount" \
  "$(sql "SELECT abs((\"oldData\"->>'grossAmount')::numeric) = 1200 FROM \"AuditLog\" WHERE \"entityId\" = '$EXP' AND action = 'expense.deleted';")" "t"
assert_eq "…and the asset it belonged to" \
  "$(sql "SELECT \"oldData\"->>'relatedAssetId' FROM \"AuditLog\" WHERE \"entityId\" = '$EXP' AND action = 'expense.deleted';")" "$ASSET"

note "=== 4. the chain verifies, and the escape hatches are deliberate ==="
AS GET "/api/v1/audit-logs/verify?companyId=$C"
assert_eq "chain ok" "$(json_field "$BODY" ok)" "True"
EXT="$SCRIPT_DIR/../src/prisma/audit-log.extension.ts"
grep -q "const BULK_SUMMARY_ONLY = new Set<string>(\['ErrorEvent'\])" "$EXT" \
  && pass "only ErrorEvent keeps count-only bulk rows" || fail "BULK_SUMMARY_ONLY changed — review it"
grep -qE "const BULK_DETAIL_CAP = [0-9]+" "$EXT" \
  && pass "a per-record cap bounds a runaway bulk" || fail "no BULK_DETAIL_CAP"

summary; exit $?
