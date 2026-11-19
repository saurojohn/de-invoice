#!/bin/bash
# Tier 879 — an invoice issued past its due date is overdue at once
#
# Found on the production images (the second walk): an invoice dated
# 01.10.2026, due 15.10., entered and issued on 19.11. stood as „Versendet“;
# the dashboard said „Überfällige Rechnungen 0 ✓“ next to it. The status
# „überfällig“ came from the nightly run (00:05) and, since Tier 829, one run
# a minute after the start — not from the issue. The first days of an
# installation are when the old invoices are entered.
#
# Now issuing, and editing an issued invoice, refresh the open status at
# once (open-status.ts, Tier 711) — in both directions.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-571-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier879-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
field() { python3 -c "import json,sys
try: print(json.loads(sys.argv[1]).get(sys.argv[2]))
except Exception: print('-')" "$BODY" "$1"; }
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde 571","type":"business","address":{"street":"Weg 2","city":"Hamburg","postalCode":"20095","country":"DE"}}'
K=$(field id)
TODAY=$(TZ=Europe/Berlin date +%F)
PAST_ISSUE=$(python3 -c "import datetime;print((datetime.date.fromisoformat('$TODAY')-datetime.timedelta(days=49)).isoformat())")
PAST_DUE=$(python3 -c "import datetime;print((datetime.date.fromisoformat('$TODAY')-datetime.timedelta(days=35)).isoformat())")
FUTURE=$(python3 -c "import datetime;print((datetime.date.fromisoformat('$TODAY')+datetime.timedelta(days=30)).isoformat())")
overdue_list() { AS GET "/api/v1/invoices?companyId=$C&pageSize=50&status=overdue"; python3 -c "import json,sys;d=json.loads(sys.argv[1]);print(' '.join(r['id'] for r in d.get('data',d.get('items',[]))))" "$BODY"; }

note "=== 1. issued past its due date ==="
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$PAST_ISSUE\",\"dueDate\":\"$PAST_DUE\",\"items\":[{\"description\":\"Altauftrag\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":500,\"vatRate\":0.19}]}"
OLD=$(field id)
AS PUT "/api/v1/invoices/$OLD/status?companyId=$C" '{"status":"sent"}'
assert_eq "issuing answers „überfällig“ (was: „sent“ until the night)" "$STATUS $(field status)" "200 overdue"
assert_eq "…and so it is stored" "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tAc "select status from \"Invoice\" where id='$OLD'")" "overdue"
assert_eq "…the dashboard's list of overdue invoices has it (was: 0 ✓)" "$(overdue_list | grep -c "$OLD")" "1"

note "=== 2. issued with a due date ahead ==="
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"dueDate\":\"$FUTURE\",\"items\":[{\"description\":\"Neuauftrag\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
NEW=$(field id)
AS PUT "/api/v1/invoices/$NEW/status?companyId=$C" '{"status":"sent"}'
assert_eq "not overdue: „sent“" "$STATUS $(field status)" "200 sent"

note "=== 3. paid in full: never overdue ==="
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$PAST_ISSUE\",\"dueDate\":\"$PAST_DUE\",\"items\":[{\"description\":\"bezahlt\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
PAID=$(field id)
AS PUT "/api/v1/invoices/$PAID/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$PAID/payments?companyId=$C" "{\"amount\":119,\"paymentDate\":\"$TODAY\",\"paymentMethod\":\"bank_transfer\"}"
assert_eq "its payment makes it paid, not overdue" "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tAc "select status from \"Invoice\" where id='$PAID'")" "paid"
summary
