#!/bin/bash
# Tier 982 — a credit-transfer batch is executed today at the earliest
#
# A SEPA batch dated 45 days back was accepted: both bills were marked paid on
# that day and the file asked the bank to execute in the past. The bank
# executes on the next business day at the earliest; the outflow is when the
# order reaches the bank (§ 11 Abs. 2 EStG) — the back-dated payment moved
# the EÜR outflow into an earlier month (or year).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-669-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F)
PAST=$(python3 -c "import datetime,sys;print(datetime.date.fromisoformat(sys.argv[1])-datetime.timedelta(days=45))" "$TODAY")
YESTERDAY=$(python3 -c "import datetime,sys;print(datetime.date.fromisoformat(sys.argv[1])-datetime.timedelta(days=1))" "$TODAY")

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier982-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/suppliers?companyId=$C" '{"name":"Lieferant","address":{"street":"a","city":"b","postalCode":"10115","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX"}}'
SUP=$(json_field "$BODY" id)
AS POST "/api/v1/ustva/expenses?companyId=$C" "{\"supplierId\":\"$SUP\",\"invoiceNumber\":\"L-1\",\"description\":\"Material\",\"invoiceDate\":\"$PAST\",\"netAmount\":100,\"vatRate\":0.19,\"vatAmount\":19,\"grossAmount\":119}"
X=$(json_field "$BODY" id)
batch() { AS POST "/api/v1/payments/batches?companyId=$C" "{\"companyId\":\"$C\",\"expenseIds\":[\"$X\"],\"executionDate\":\"$1\",\"debtorIban\":\"DE02120300000000202051\",\"debtorName\":\"$TAG GmbH\"}"; }
paid() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "select coalesce(\"paidAt\"::date::text, 'open') from \"Expense\" where id='$X'"; }

batch "$PAST"
assert_eq "a batch dated 45 days back: refused (was 201, the bill paid on $PAST)" "$STATUS/$(paid)" "400/open"
batch "$YESTERDAY"
assert_eq "…yesterday: refused" "$STATUS/$(paid)" "400/open"
batch "$TODAY"
assert_eq "today: the batch, the bill paid today" "$STATUS/$(paid)" "201/$TODAY"

summary
