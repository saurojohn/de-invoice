#!/bin/bash
# Tier 711 — an invoice marked „überfällig“ is still dunned
#
# Tier 710's nightly job sets the status `overdue`. The Mahnwesen read
# `status: 'sent'` only: the list of overdue invoices, its count and amount,
# and the automatic run (daily 09:00) — so from the first night on, a marked
# invoice was never dunned again, automatically or from the list. Measured
# with the test mailbox: after the job, auto-run sent 0 letters.
# And the status follows what changes it: a payment removed put a long
# overdue invoice back to „versendet“ (until the next night); an invoice
# given a Ratenplan stayed „überfällig“ under it; a plan cancelled left it
# „versendet“ until the next night.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-432-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
FUTURE=$(python3 -c "import datetime,zoneinfo;print((datetime.datetime.now(zoneinfo.ZoneInfo('Europe/Berlin')).date()+datetime.timedelta(days=20)).isoformat())")
WORK=$(mktemp -d); BOX="$WORK/box"
python3 "$SCRIPT_DIR/fixtures/smtp-sink.py" "$BOX" > "$WORK/port" 2> "$WORK/sink.err" < /dev/null &
SINK=$!
trap '{ kill $SINK; wait $SINK; } 2>/dev/null; rm -rf "$WORK"' EXIT
for _ in $(seq 1 50); do [[ -s "$WORK/port" ]] && break; python3 -c "import time; time.sleep(0.1)"; done
PORT=$(cat "$WORK/port")
[[ -n "$PORT" ]] && pass "fixture: a mailbox on 127.0.0.1:$PORT" || { fail "the mailbox did not start"; summary; exit 1; }
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier711-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C" DE123456789
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
q "update \"Company\" set \"bankInfo\"='{\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\",\"bankName\":\"Bank\"}'::jsonb where id='$C'" >/dev/null
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
status_of() { q "select status from \"Invoice\" where id='$1'"; }
AS PUT "/api/v1/mail/config?companyId=$C" "{\"smtpHost\":\"127.0.0.1\",\"smtpPort\":$PORT,\"smtpSecure\":false,\"smtpUser\":\"u\",\"smtpPassword\":\"p\",\"fromEmail\":\"rechnung@example.test\",\"fromName\":\"$TAG\",\"enabled\":true}"
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde AG\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"},\"contact\":{\"email\":\"buchhaltung@kunde.example.test\"}}"
K=$(json_field "$BODY" id)
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Zweitkunde AG\",\"type\":\"business\",\"address\":{\"street\":\"Ring 3\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"},\"contact\":{\"email\":\"zweit@kunde.example.test\"}}"
K2=$(json_field "$BODY" id)
inv() { # customer → I (1 190 €, due 15.08.2026, issued)
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"2026-08-01\",\"dueDate\":\"2026-08-15\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
  I=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
}
inv "$K"; DUN=$I
inv "$K2"; PLAN=$I
AS POST "/api/v1/invoice-status/_test/mark-overdue?companyId=$C" '{}'
assert_eq "fixture: the night's job marked both „überfällig“" "$(P "d['marked']")/$(status_of "$DUN")/$(status_of "$PLAN")" "2/overdue/overdue"

note "=== 1. the Mahnwesen sees it ==="
AS GET "/api/v1/reminders/overdue?companyId=$C"
assert_eq "the list of overdue invoices holds both (was empty)" "$(P "sorted(r['id'] for r in d) == sorted(['$DUN', '$PLAN'])")" "True"
AS GET "/api/v1/reminders/stats?companyId=$C"
assert_eq "…its count (was 0)" "$(P "d.get('overdueCount')")" "2"
AS POST "/api/v1/reminders/auto-run?companyId=$C" '{}'
assert_eq "the automatic run: a letter for each (was 0)" "$STATUS/$(P "d.get('sent')")" "201/2"
assert_eq "…in the mailbox" "$(ls "$BOX" 2>/dev/null | wc -l | tr -d ' ')" "2"

note "=== 2. a payment removed ==="
AS POST "/api/v1/invoices/$DUN/payments?companyId=$C" '{"amount":1190,"paymentDate":"2026-09-01","paymentMethod":"bank_transfer"}'
PAY=$(json_field "$BODY" id)
assert_eq "paid: bezahlt" "$(status_of "$DUN")" "paid"
AS DELETE "/api/v1/invoices/$DUN/payments/$PAY?companyId=$C"
assert_eq "the payment removed: „überfällig“ again (was: „versendet“ until the next night)" "$STATUS/$(status_of "$DUN")" "200/overdue"

note "=== 3. a Ratenplan ==="
AS POST "/api/v1/installment-plans/from-invoice?companyId=$C" "{\"invoiceId\":\"$PLAN\",\"installmentCount\":3,\"firstDueDate\":\"$FUTURE\",\"createdById\":\"$U\"}"
PID=$(json_field "$BODY" id)
assert_eq "a plan agreed: „versendet“ — not overdue under its Raten (was: „überfällig“)" "$STATUS/$(status_of "$PLAN")" "201/sent"
AS POST "/api/v1/invoice-status/_test/mark-overdue?companyId=$C" '{}'
assert_eq "…and the night leaves it so" "$(status_of "$PLAN")" "sent"
AS DELETE "/api/v1/installment-plans/$PID?companyId=$C"
assert_eq "the plan cancelled: „überfällig“ at once (was: „versendet“ until the next night)" "$STATUS/$(status_of "$PLAN")" "200/overdue"

summary
