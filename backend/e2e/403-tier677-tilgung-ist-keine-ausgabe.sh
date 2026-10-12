#!/bin/bash
# Tier 677 — the repayment of a loan is no expense.
#
# Only a loan's interest is a cost (§ 4 Abs. 4, § 9 Abs. 1 Satz 3 Nr. 1
# EStG). Entered as an expense with the category „Darlehenstilgung“,
# 9 000 € stood as a Betriebsausgabe in the EÜR, in Anlage S and in
# Anlage G (measured; Tier 673 had found it in Anlage V), and went with the
# other expenses into the P&L reports and the DATEV export.
#
# Now: such an expense is refused when it is entered, edited or imported,
# with the reason and what to enter instead; and a row that is there already
# costs nothing in the forms.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-403-$(date +%s%N | cut -c1-13)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"; rm -f "$SCRIPT_DIR/../.tier677-probe.ts"' EXIT
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
SQL() { docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice -q -At -c "$1"; }
Y=2025

note "=== 1. what a repayment is ==="
cat > "$SCRIPT_DIR/../.tier677-probe.ts" <<'TS'
import { isLoanRepayment as r, expenseCost as c } from './src/modules/accounting/expense-cost'
const yes = ['Darlehenstilgung', 'Tilgung', 'Tilgung Hypothek', 'Darlehen', 'Darlehen Rate Mai', 'Hypothek', 'Kredit', 'Kreditrate', 'Kredit Rückzahlung']
const no = ['Schuldzinsen', 'Darlehenszinsen', 'Darlehen Zinsen', 'Kreditkartengebühr', 'Kreditkarte', 'Kreditzinsen', 'Darlehensgebühr', 'Hypothekenzinsen', 'Büromaterial', '', 'Kreditversicherung', 'Kreditorenbuchhaltung']
console.log(`yes=${yes.filter((x) => !r(x)).join('|') || 'all'}`)
console.log(`no=${no.filter((x) => r(x)).join('|') || 'none'}`)
console.log(`cost=${c({ netAmount: 9000, grossAmount: 9000, category: 'Darlehenstilgung' }, false)}/${c({ netAmount: 100, grossAmount: 119, category: 'Büromaterial' }, false)}/${c({ netAmount: 100, grossAmount: 119, category: 'Büromaterial' }, true)}`)
TS
( cd "$SCRIPT_DIR/.." && npx ts-node -T .tier677-probe.ts > "$TMP/probe.txt" 2>&1 )
P() { grep "^$1=" "$TMP/probe.txt" | head -1 | cut -d= -f2-; }
assert_eq "a repayment: named so, or a loan without its interest" "$(P yes)" "all"
assert_eq "not one: interest, fees, the credit card, anything else" "$(P no)" "none"
assert_eq "it costs nothing; other expenses as before (net, gross for a Kleinunternehmer)" "$(P cost)" "0/100/119"

note "=== 2. refused when it is entered ==="
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier677-e2e\",\"companyName\":\"$TAG\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
AS POST "/api/v1/suppliers?companyId=$C" '{"name":"Hausbank","address":{"street":"a","city":"b","postalCode":"1","country":"DE"}}'; SUP=$(field "d['id']")
body() { echo "{\"supplierId\":\"$SUP\",\"invoiceNumber\":\"$1\",\"description\":\"$2\",\"invoiceDate\":\"$Y-05-10\",\"paidAt\":\"$Y-05-12\",\"category\":\"$2\",\"netAmount\":$3,\"vatRate\":0,\"vatAmount\":0,\"grossAmount\":$3,\"confirmDuplicate\":true}"; }
AS POST "/api/v1/expenses?companyId=$C" "$(body B-1 Darlehenstilgung 9000)"
assert_eq "„Darlehenstilgung“ as an expense: refused (was taken)" "$STATUS" "400"
echo "$BODY" | grep -q "Die Tilgung eines Darlehens ist keine Ausgabe" && echo "$BODY" | grep -q "Schuldzinsen" \
  && pass "… with the reason, and what to enter instead" || fail "the refusal does not explain itself"
AS POST "/api/v1/expenses?companyId=$C" "$(body B-2 Schuldzinsen 2400)"; INTEREST=$(field "d['id']")
assert_eq "the interest is an expense" "$STATUS" "201"
AS POST "/api/v1/expenses?companyId=$C" "$(body B-3 Kreditkartengebühr 30)"
assert_eq "so is the credit card's fee" "$STATUS" "201"
AS PUT "/api/v1/expenses/$INTEREST?companyId=$C" '{"category":"Tilgung"}'
assert_eq "an expense cannot be turned into a repayment" "$STATUS" "400"
assert_eq "… it keeps its category" "$(SQL "SELECT category FROM \"Expense\" WHERE id = '$INTEREST'")" "Schuldzinsen"

note "=== 3. a row from before costs nothing ==="
SQL "INSERT INTO \"Expense\" (id, \"companyId\", \"invoiceNumber\", description, \"invoiceDate\", \"paidAt\", \"netAmount\", \"vatRate\", \"vatAmount\", \"grossAmount\", category, \"isIntraEU\", \"isReverseCharge\", status, \"createdAt\", \"updatedAt\") VALUES (gen_random_uuid(), '$C', 'ALT-1', 'Darlehenstilgung', '$Y-05-10', '$Y-05-12', 9000, 0, 0, 9000, 'Darlehenstilgung', false, false, 'booked', NOW(), NOW())" >/dev/null
AS GET "/api/v1/accounting/euer?companyId=$C&year=$Y"
assert_eq "EÜR: 2 430 € of expenses — interest and fee (were 11 430 €)" "$(field "(d['totals']['ausgabenTotal'], d['totals']['gewinn'])")" "(2430, -2430)"
AS GET "/api/v1/accounting/anlage-s?companyId=$C&year=$Y"
assert_eq "Anlage S the same" "$(field "d['totals']['ausgabenTotal']")" "2430"
AS GET "/api/v1/accounting/anlage-g?companyId=$C&year=$Y"
assert_eq "Anlage G the same" "$(field "abs(d['totals']['betriebsausgabenTotal'])")" "2430"
AS GET "/api/v1/accounting/anlage-v?companyId=$C&year=$Y"
assert_eq "Anlage V: the interest, and the repayment reported" "$(field "(d['totals']['werbungskostenTotal'], d['counts']['tilgung']['count'], d['counts']['tilgung']['amount'])")" "(2430, 1, 9000)"

summary
