#!/bin/bash
# Tier 993 — a consumer owes Verzugszinsen from the reminder on, not from the due date
#
# A consumer is in default through a Mahnung (§ 286 Abs. 1 BGB) — a due date
# the invoice set on its own is no agreed calendar date (Abs. 2 Nr. 1), and the
# invoices carry no notice of Abs. 3 Satz 1 Hs. 2. Measured: the Zahlungs-
# erinnerung to a private customer (1 190 €, due in June) asked 34,31 € interest
# from the due date; the later levels counted from the due date as well.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-680-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F)
ISS=$(python3 -c "import datetime,sys;print(datetime.date.fromisoformat(sys.argv[1])-datetime.timedelta(days=130))" "$TODAY")
DUE=$(python3 -c "import datetime,sys;print(datetime.date.fromisoformat(sys.argv[1])-datetime.timedelta(days=100))" "$TODAY")
SENT=$(python3 -c "import datetime,sys;print(datetime.date.fromisoformat(sys.argv[1])-datetime.timedelta(days=30))" "$TODAY")

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier993-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"email":"info@t993.example","address":{"street":"Hauptstr. 1","city":"Berlin","postalCode":"10115","country":"DE"}}'
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Privat\",\"type\":\"individual\",\"contact\":{\"email\":\"p-$TAG@example.test\"},\"address\":{\"street\":\"Weg 2\",\"city\":\"Köln\",\"postalCode\":\"50667\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$ISS\",\"deliveryDate\":\"$ISS\",\"dueDate\":\"$DUE\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
zins() { AS GET "/api/v1/reminders/mahnungen/fees-preview?companyId=$C&invoiceId=$I&level=$1"; P "'%.2f' % d['verzugszins']"; }
assert_eq "the Zahlungserinnerung to a consumer: no interest (was: from the due date)" "$(zins first)" "0.00"
assert_eq "…nor the 1. Mahnung while no reminder went out" "$(zins second)" "0.00"
AS POST "/api/v1/reminders/send" "{\"companyId\":\"$C\",\"invoiceId\":\"$I\",\"level\":\"first\"}"
assert_eq "the Zahlungserinnerung sent" "${STATUS:0:2}" "20"
# it went out 30 days ago
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc "update \"Mahnung\" set \"sentAt\"='$SENT', \"createdAt\"='$SENT' where \"invoiceId\"='$I'" >/dev/null
AS GET "/api/v1/reminders/mahnungen/fees-preview?companyId=$C&invoiceId=$I&level=second"
EXP=$(P "'%.2f' % (round(1190 * d['verzugszinsPct'] * 30 / 365) / 100)")
assert_eq "the 1. Mahnung: interest from the day after the reminder — 30 days at Basiszinssatz + 5" "$(P "'%.2f' % d['verzugszins']")" "$EXP"

summary
