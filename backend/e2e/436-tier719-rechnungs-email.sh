#!/bin/bash
# Tier 719 — a customer's address for invoices („E-Mail für Rechnungen“)
#
# A customer had one e-mail address, its contact's — invoices, reminders,
# statements and the invoices of a recurring template went there. Many firms
# take invoices at an address of their own (buchhaltung@ …). `contact.
# invoiceEmail` is that address; where it is empty, nothing changes.
# Measured with the test mailbox: every letter goes to the address for
# invoices, a customer without one gets them at the contact's.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-436-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
WORK=$(mktemp -d); BOX="$WORK/box"
python3 "$SCRIPT_DIR/fixtures/smtp-sink.py" "$BOX" > "$WORK/port" 2> "$WORK/sink.err" < /dev/null &
SINK=$!
trap '{ kill $SINK; wait $SINK; } 2>/dev/null; rm -rf "$WORK"' EXIT
for _ in $(seq 1 50); do [[ -s "$WORK/port" ]] && break; python3 -c "import time; time.sleep(0.1)"; done
PORT=$(cat "$WORK/port")
[[ -n "$PORT" ]] && pass "fixture: a mailbox on 127.0.0.1:$PORT" || { fail "the mailbox did not start"; summary; exit 1; }
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier719-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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
AS PUT "/api/v1/mail/config?companyId=$C" "{\"smtpHost\":\"127.0.0.1\",\"smtpPort\":$PORT,\"smtpSecure\":false,\"smtpUser\":\"u\",\"smtpPassword\":\"p\",\"fromEmail\":\"rechnung@example.test\",\"fromName\":\"$TAG\",\"enabled\":true}"
ADDR='"address":{"street":"Ring 2","postalCode":"80331","city":"München","country":"DE"}'
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde AG\",\"type\":\"business\",$ADDR,\"contact\":{\"email\":\"info@kunde.example.test\",\"invoiceEmail\":\"buchhaltung@kunde.example.test\",\"name\":\"Frau Weber\"}}"
assert_eq "a customer with an address for invoices" "$STATUS" "201"
K=$(json_field "$BODY" id)
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Zweit AG\",\"type\":\"business\",$ADDR,\"contact\":{\"email\":\"info@zweit.example.test\"}}"
K2=$(json_field "$BODY" id)
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Falsch AG\",\"type\":\"business\",$ADDR,\"contact\":{\"invoiceEmail\":\"keine-adresse\"}}"
assert_eq "an address for invoices that is none: 400" "$STATUS" "400"
assert_eq "…kept on the customer" "$(q "select contact->>'invoiceEmail' from \"Customer\" where id='$K'")" "buchhaltung@kunde.example.test"

inv() { # customer → I
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"2026-08-01\",\"dueDate\":\"2026-08-15\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
  I=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
}
last_to() { python3 - "$BOX" <<'PY'
import email, os, sys
d = sys.argv[1]
f = sorted(os.listdir(d))[-1]
m = email.message_from_bytes(open(os.path.join(d, f), 'rb').read())
print(m['To'])
PY
}
mails() { ls "$BOX" 2>/dev/null | wc -l | tr -d ' '; }
inv "$K"; A=$I
inv "$K2"; B=$I

AS POST "/api/v1/invoices/$A/send-email?companyId=$C" '{}'
assert_eq "the invoice: to the address for invoices (was info@)" "$STATUS/$(mails)/$(last_to)" "201/1/buchhaltung@kunde.example.test"
AS POST "/api/v1/reminders/send" "{\"companyId\":\"$C\",\"invoiceId\":\"$A\",\"level\":\"first\",\"createdById\":\"$U\"}"
assert_eq "the Mahnung: there too" "$(mails)/$(last_to)" "2/buchhaltung@kunde.example.test"
AS POST "/api/v1/customers/$K/statement.email?companyId=$C" "{\"companyId\":\"$C\",\"from\":\"2026-08-01\",\"to\":\"2026-10-31\"}"
assert_eq "the statement: there too" "$STATUS/$(mails)/$(last_to)" "200/3/buchhaltung@kunde.example.test"
AS POST "/api/v1/invoices/$B/send-email?companyId=$C" '{}'
assert_eq "a customer without one: to its contact, as before" "$STATUS/$(mails)/$(last_to)" "201/4/info@zweit.example.test"

summary
