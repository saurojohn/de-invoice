#!/bin/bash
# Tier 992 — interest accrues on what was owed each day
#
# Verzugszinsen were computed on today's open balance for the whole time since
# the due date: an invoice of 11 900 €, overdue since June, 10 000 € paid on
# 20.11. — the preview demanded the interest on 1 900 € for all 162 days and
# dropped what the 10 000 € had accrued before they were paid (§ 288 BGB: the
# interest runs on the debt as it stands on each day).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-679-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F)
ISS=$(python3 -c "import datetime,sys;print(datetime.date.fromisoformat(sys.argv[1])-datetime.timedelta(days=190))" "$TODAY")
DUE=$(python3 -c "import datetime,sys;print(datetime.date.fromisoformat(sys.argv[1])-datetime.timedelta(days=160))" "$TODAY")
MID=$(python3 -c "import datetime,sys;print(datetime.date.fromisoformat(sys.argv[1])-datetime.timedelta(days=80))" "$TODAY")

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier992-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"contact\":{\"email\":\"k-$TAG@example.test\"},\"address\":{\"street\":\"Weg 2\",\"city\":\"Köln\",\"postalCode\":\"50667\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
inv() {
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$ISS\",\"deliveryDate\":\"$ISS\",\"dueDate\":\"$DUE\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":10000,\"vatRate\":0.19}]}"
  I=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
}
zins() { AS GET "/api/v1/reminders/mahnungen/fees-preview?companyId=$C&invoiceId=$1&level=second"; python3 -c "import sys,json;print('%.2f' % json.loads(sys.argv[1])['verzugszins'])" "$BODY"; }
pay() { AS POST "/api/v1/invoices/$1/payments?companyId=$C" "{\"amount\":10000,\"paymentDate\":\"$2\",\"paymentMethod\":\"bank_transfer\"}"; }

inv; A=$I
FULL=$(zins "$A")
SHARE=$(python3 -c "print('%.2f' % (float('$FULL') * 1900 / 11900))")
pay "$A" "$TODAY"
assert_eq "10 000 € paid today: the interest up to today stays on 11 900 € — $FULL (was $SHARE, on 1 900 €)" "$(zins "$A")" "$FULL"

inv; B=$I
pay "$B" "$MID"
assert_eq "10 000 € paid 80 days ago: between the interest on 1 900 € and on 11 900 € (was the 1 900 € share)" \
  "$(python3 -c "v=float('$(zins "$B")'); print(float('$SHARE') + 1 < v < float('$FULL') - 1)")" "True"

summary
