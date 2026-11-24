#!/bin/bash
# Tier 995 — a direct-debit batch collects today at the earliest
#
# As the credit-transfer batch before Tier 982: a pain.008 dated weeks back
# was accepted — the file asked the bank to collect in the past
# (ReqdColltnDt), the pre-notification deadline lay before the batch was made.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-682-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
TODAY=$(TZ=Europe/Berlin date +%F)
PAST=$(python3 -c "import datetime,sys;print(datetime.date.fromisoformat(sys.argv[1])-datetime.timedelta(days=30))" "$TODAY")
AHEAD=$(python3 -c "import datetime,sys;print(datetime.date.fromisoformat(sys.argv[1])+datetime.timedelta(days=20))" "$TODAY")
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier995-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C" DE123456789
q "update \"Company\" set \"bankInfo\"='{\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\",\"bankName\":\"Bank\"}'::jsonb where id='$C'" >/dev/null
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde AG\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
AS POST "/api/v1/payments/mandates?companyId=$C" "{\"companyId\":\"$C\",\"customerId\":\"$K\",\"dateOfSignature\":\"2026-07-20\",\"type\":\"CORE\",\"iban\":\"DE02120300000000202051\",\"bic\":\"BYLADEM1001\",\"debitorName\":\"$TAG Kunde AG\"}"
M=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$PAST\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
batch() { AS POST "/api/v1/payments/direct-debit/batches?companyId=$C" "{\"companyId\":\"$C\",\"executionDate\":\"$1\",\"collections\":[{\"invoiceId\":\"$I\",\"mandateId\":\"$M\"}]}"; }
batch "$PAST"
assert_eq "a collection dated 30 days back: refused (was 201)" "$STATUS" "400"
assert_eq "…no batch, no collection" "$(q "select count(*) from \"SepaDirectDebitCollection\" where \"invoiceId\"='$I'")" "0"
batch "$AHEAD"
assert_eq "20 days ahead: the batch" "$STATUS" "201"

summary
