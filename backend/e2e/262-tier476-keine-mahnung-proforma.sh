#!/bin/bash
# Tier 476 — no Mahnung for a Proforma
#
# A Proforma asks for an advance; it creates no claim, so the customer cannot
# be in default. Measured before: POST /reminders/send for a sent, "overdue"
# Proforma → 201, a level-2 Mahnung with 5,00 € fee and 36,23 € interest
# (1 231,23 € demanded) e-mailed to the customer. The cron already took only
# invoices; the manual and bulk send did not check.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-262-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier476-e2e\",\"companyName\":\"$TAG Handel\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C"
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Teststr. 9\",\"postalCode\":\"10115\",\"city\":\"Berlin\",\"country\":\"DE\"},\"contact\":{\"email\":\"kunde@example.test\"}}"; K=$(json_field "$BODY" id)
doc() { # type
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"type\":\"$1\",\"issueDate\":\"2026-06-01\",\"dueDate\":\"2026-06-15\",\"items\":[{\"description\":\"Maschine\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  echo "$id"
}
PI=$(doc PI); INV=$(doc INV)

AS POST "/api/v1/reminders/send" "{\"companyId\":\"$C\",\"invoiceId\":\"$PI\",\"level\":\"second\"}"
assert_eq "Mahnung for a Proforma refused (was 201)" "$STATUS" "400"
AS POST "/api/v1/reminders/bulk-send" "{\"companyId\":\"$C\",\"invoiceIds\":[\"$PI\"],\"level\":\"first\"}"
assert_eq "…in the bulk send too" "$(json_field "$BODY" failed)" "1"
assert_eq "no Mahnung row for it" \
  "$(docker exec "${PG_CONTAINER:-de-invoice-postgres}" psql -U de_invoice -d de_invoice -tAc "select count(*) from \"Mahnung\" where \"invoiceId\"='$PI'")" "0"
AS POST "/api/v1/reminders/send" "{\"companyId\":\"$C\",\"invoiceId\":\"$INV\",\"level\":\"first\"}"
assert_eq "an overdue invoice is still dunned" "$STATUS" "201"

summary
