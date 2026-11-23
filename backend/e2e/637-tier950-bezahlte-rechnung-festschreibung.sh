#!/bin/bash
# Tier 950 — what the review of Tier 944 found (a bill's payment and the closed books)
#
# Measured on the Tier 949 code (books closed to 31.12.2025):
# 1. a bill paid on 20.12.2025 (invoice of 05.01.2026): its amount changed —
#    taken, the closed EÜR 2025 rose (its deletion was refused already);
# 2. a SEPA batch carried out on 15.12.2025: taken — the bills paid in the
#    closed year; its cancellation took them out again;
# 3. notes „Rückfrage [bank-expense]“: kept, and the bill locked as a
#    reversed bank booking.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-637-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier950-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a sole trader (EÜR)" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc \
  "update \"Company\" set \"bankInfo\" = coalesce(\"bankInfo\", '{}'::jsonb) || '{\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\"}'::jsonb where id='$C'" >/dev/null
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"rechtsform":"Einzelunternehmen","besteuerungsart":"soll","gewinnermittlung":"euer"}'
AS POST "/api/v1/suppliers?companyId=$C" "{\"name\":\"$TAG Lieferant\",\"address\":{\"street\":\"a\",\"city\":\"b\",\"postalCode\":\"10115\",\"country\":\"DE\"},\"bankInfo\":{\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\",\"accountHolder\":\"$TAG Lieferant\"}}"
SUP=$(json_field "$BODY" id)
bill() { # date net [paidAt] → E
  AS POST "/api/v1/ustva/expenses?companyId=$C" "{\"supplierId\":\"$SUP\",\"description\":\"Material\",\"invoiceDate\":\"$1\",\"netAmount\":$2,\"vatRate\":0.19,\"vatAmount\":$(python3 -c "print(round($2*0.19,2))"),\"grossAmount\":$(python3 -c "print(round($2*1.19,2))")${3:+,\"paidAt\":\"$3\"}}"
  E=$(json_field "$BODY" id)
}

# before the closing: a bill paid in advance in December, one for the SEPA run
bill 2026-01-05 1000 2025-12-20; PAID=$E
bill 2025-12-01 500; OPEN=$E
AS PUT "/api/v1/accounting/books-closing?companyId=$C" '{"closedUntil":"2025-12-31"}'
assert_eq "the books closed to 31.12.2025" "$STATUS" "200"

note "=== 1. a bill paid in the closed year ==="
AS PUT "/api/v1/expenses/$PAID?companyId=$C" '{"netAmount":2000,"vatAmount":380,"grossAmount":2380}'
assert_eq "its amount cannot change (was 200 — the EÜR 2025 rose by 1 000 €)" \
  "$STATUS/$(P "'Festschreibung' in str(d.get('message'))")" "400/True"
AS PUT "/api/v1/expenses/$PAID?companyId=$C" '{"notes":"Vorkasse laut Auftrag"}'
assert_eq "…its notes can" "$STATUS" "200"

note "=== 2. a SEPA batch carried out in the closed year ==="
AS POST "/api/v1/payments/batches?companyId=$C" "{\"companyId\":\"$C\",\"expenseIds\":[\"$OPEN\"],\"executionDate\":\"2025-12-15\",\"notes\":\"$TAG\"}"
assert_eq "refused (was 201 — the bill paid in the closed EÜR 2025)" "$STATUS" "400"

note "=== 3. what reads as a marker ==="
bill 2026-02-01 10
AS PUT "/api/v1/expenses/$E?companyId=$C" '{"notes":"Rückfrage [bank-expense] und [ Skonto-Voucher: alt]"}'
AS GET "/api/v1/expenses/$E?companyId=$C"
assert_eq "not taken into the notes (was kept, and the bill locked)" "$(P "d['notes']")" "Rückfrage und"
AS DELETE "/api/v1/ustva/expenses/$E?companyId=$C"
assert_eq "…so the bill can still be deleted" "$STATUS" "200"

summary
