#!/bin/bash
# Tier 489 — a supplier invoice is entered once
#
# Measured before: invoice RE-4711 of one supplier entered three times (twice
# via /ustva/expenses, once via /expenses) — 201 each, and the UStVA deducted
# 57 € input tax instead of 19. The same supplier's number again is now
# refused (409, naming the bill already entered) unless confirmDuplicate
# says it is a second bill; the CSV import reports such a row instead of
# importing it. Another supplier's number, or the supplier's credit note
# under the same number, is no duplicate.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-275-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier489-e2e\",\"companyName\":\"$TAG Handel\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
supplier() { AS POST "/api/v1/suppliers?companyId=$C" "{\"name\":\"$1\",\"address\":{\"street\":\"a\",\"city\":\"b\",\"postalCode\":\"1\",\"country\":\"DE\"}}"; json_field "$BODY" id; }
S=$(supplier "$TAG Lieferant"); S2=$(supplier "$TAG Andere")
bill() { # endpoint supplier extra
  AS POST "$1?companyId=$C" "{\"supplierId\":\"$2\",\"invoiceNumber\":\"RE-4711\",\"description\":\"Material\",\"invoiceDate\":\"2026-09-10\",\"netAmount\":100,\"vatRate\":0.19,\"vatAmount\":19,\"grossAmount\":119$3}"
}

bill /api/v1/ustva/expenses "$S" ''
assert_eq "the bill" "$STATUS" "201"
bill /api/v1/ustva/expenses "$S" ''
assert_eq "the same number again: refused (was 201)" "$STATUS" "409"
assert_eq "…naming the bill already entered" "$(P "'bereits erfasst' in d['message'] and '119,00' in d['message']")" "True"
bill /api/v1/expenses "$S" ''
assert_eq "…on the other endpoint too (was 201)" "$STATUS" "409"
bill /api/v1/ustva/expenses "$S" ', "invoiceNumber":" re-4711 "'
assert_eq "…whatever the case and spaces" "$STATUS" "409"

AS GET "/api/v1/ustva/compute?companyId=$C&year=2026&month=9"
assert_eq "UStVA: Vorsteuer 19 (was 76 — all four entries)" "$(P "d['vorsteuerSum']")" "19"

bill /api/v1/ustva/expenses "$S2" ''
assert_eq "another supplier's RE-4711 is no duplicate" "$STATUS" "201"
bill /api/v1/ustva/expenses "$S" ', "creditNote":true'
assert_eq "the supplier's credit note under the number is no duplicate" "$STATUS" "201"
bill /api/v1/ustva/expenses "$S" ', "confirmDuplicate":true'
assert_eq "a confirmed second bill is taken" "$STATUS" "201"

AS POST "/api/v1/expenses/import?companyId=$C" "{\"rows\":[{\"description\":\"CSV\",\"invoiceDate\":\"2026-09-11\",\"supplierId\":\"$S2\",\"invoiceNumber\":\"RE-4711\",\"netAmount\":\"100\",\"vatRate\":\"0.19\",\"vatAmount\":\"19\"},{\"description\":\"CSV neu\",\"invoiceDate\":\"2026-09-11\",\"supplierId\":\"$S2\",\"invoiceNumber\":\"RE-4712\",\"netAmount\":\"50\",\"vatRate\":\"0.19\",\"vatAmount\":\"9.5\"}]}"
assert_eq "CSV: the known bill reported (row 2 — the header is row 1), the new one imported" "$(P "(d['imported'], [e['row'] for e in d['errors']])")" "(1, [2])"

summary
