#!/bin/bash
# Tier 705 — every letter greets as the invoice e-mail does
#
# Tier 691 made the invoice e-mail greet a company „Sehr geehrte Damen und
# Herren“. The reminder e-mails, the Mahnung letter (PDF) and the account
# statement e-mail kept „Sehr geehrte/r <name>“ — measured: „Sehr geehrte/r
# Kunde AG,“ in all three. And a contact entered with its title, „Frau
# Weber“, was greeted „Sehr geehrte/r Frau Weber“ everywhere.
# Now one rule (greetingLine): a company without a contact person „Sehr
# geehrte Damen und Herren“, „Frau …“ „Sehr geehrte Frau …“, „Herr …“ „Sehr
# geehrter Herr …“, any other name „Sehr geehrte/r <name>“; a reminder text
# stored before (opening „Sehr geehrte/r {{customerName}}“) greets so too.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-427-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
WORK=$(mktemp -d); BOX="$WORK/box"
# (all three streams away from the spec's own: a mailbox that outlived the spec
# would otherwise hold the suite runner's pipe open)
python3 "$SCRIPT_DIR/fixtures/smtp-sink.py" "$BOX" > "$WORK/port" 2> "$WORK/sink.err" < /dev/null &
SINK=$!
trap '{ kill $SINK; wait $SINK; } 2>/dev/null; rm -rf "$WORK"' EXIT
for _ in $(seq 1 50); do [[ -s "$WORK/port" ]] && break; python3 -c "import time; time.sleep(0.1)"; done
PORT=$(cat "$WORK/port")
[[ -n "$PORT" ]] && pass "fixture: a mailbox on 127.0.0.1:$PORT" || { fail "the mailbox did not start"; summary; exit 1; }
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier705-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C" DE123456789
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
AS PUT "/api/v1/mail/config?companyId=$C" "{\"smtpHost\":\"127.0.0.1\",\"smtpPort\":$PORT,\"smtpSecure\":false,\"smtpUser\":\"u\",\"smtpPassword\":\"p\",\"fromEmail\":\"rechnung@example.test\",\"fromName\":\"$TAG\",\"enabled\":true}"
customer() { # name type contact-json → id
  AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$1\",\"type\":\"$2\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"},\"contact\":$3}"
  json_field "$BODY" id
}
overdue() { # customer → invoice id, issued, due 15.08.
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"2026-08-01\",\"dueDate\":\"2026-08-15\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
  local id; id=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$id/status?companyId=$C" '{"status":"sent"}'
  echo "$id"
}
FIRMA=$(customer "$TAG Kunde AG" business '{"email":"firma@kunde.example.test"}')
FRAU=$(customer "$TAG Weber KG" business '{"email":"weber@kunde.example.test","name":"Frau Weber"}')
HERR=$(customer "$TAG Schmidt OHG" business '{"email":"schmidt@kunde.example.test","name":"Herr Dr. Schmidt"}')
PRIVAT=$(customer "Max Muster" individual '{"email":"max@kunde.example.test"}')
I_FIRMA=$(overdue "$FIRMA"); I_FRAU=$(overdue "$FRAU"); I_HERR=$(overdue "$HERR"); I_PRIVAT=$(overdue "$PRIVAT")
first_line() { python3 -c "import sys,json;print(json.loads(sys.argv[1])['body'].split('\n')[0])" "$BODY"; }

note "=== 1. the reminder e-mail ==="
greet() { AS GET "/api/v1/reminders/templates/first/preview?companyId=$C&invoiceId=$1"; first_line; }
assert_eq "a company without a contact person (was: Sehr geehrte/r $TAG Kunde AG,)" "$(greet "$I_FIRMA")" "Sehr geehrte Damen und Herren,"
assert_eq "„Frau Weber“ (was: Sehr geehrte/r Frau Weber,)" "$(greet "$I_FRAU")" "Sehr geehrte Frau Weber,"
assert_eq "„Herr Dr. Schmidt“" "$(greet "$I_HERR")" "Sehr geehrter Herr Dr. Schmidt,"
assert_eq "a private customer by name" "$(greet "$I_PRIVAT")" "Sehr geehrte/r Max Muster,"
# a text stored before this tier, with the opener of its day
q "update \"ReminderTemplate\" set body = replace(body, '{{greeting}},', 'Sehr geehrte/r {{customerName}},') where \"companyId\"='$C' and level='first'" >/dev/null
assert_eq "…a stored text with the old opener greets so too" "$(q "select count(*) from \"ReminderTemplate\" where \"companyId\"='$C' and level='first' and body like 'Sehr geehrte/r {{customerName}},%'")/$(greet "$I_FIRMA")" "1/Sehr geehrte Damen und Herren,"

note "=== 2. the Mahnung letter ==="
AS POST "/api/v1/reminders/send" "{\"companyId\":\"$C\",\"invoiceId\":\"$I_FIRMA\",\"level\":\"first\",\"createdById\":\"$U\"}"
M=$(json_field "$BODY" mahnungId)
assert_eq "sent: a Mahnung" "$STATUS/$([[ -n "$M" ]] && echo yes)" "201/yes"
curl -sS -o "$WORK/m.pdf" "$API/api/v1/reminders/mahnungen/$M/pdf?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C"
assert_eq "the letter greets the company (was: Sehr geehrte/r … Kunde AG)" "$(pdf_text "$WORK/m.pdf" --lines | grep -c '^Sehr geehrte Damen und Herren,$')/$(pdf_text "$WORK/m.pdf" | grep -c 'geehrte/r')" "1/0"
python3 - "$BOX" "$WORK/sent.pdf" <<'PY'
import email, os, sys
box, out = sys.argv[1], sys.argv[2]
m = email.message_from_bytes(open(os.path.join(box, sorted(os.listdir(box))[-1]), 'rb').read())
for part in m.walk():
    if part.get_content_type() == 'application/pdf':
        open(out, 'wb').write(part.get_payload(decode=True)); break
PY
assert_eq "…the one e-mailed too" "$(pdf_text "$WORK/sent.pdf" --lines | grep -c '^Sehr geehrte Damen und Herren,$')" "1"

note "=== 3. the account statement e-mail ==="
AS POST "/api/v1/customers/$FRAU/statement.email?companyId=$C" "{\"companyId\":\"$C\",\"from\":\"2026-08-01\",\"to\":\"2026-10-31\"}"
assert_eq "sent" "$STATUS" "200"
TEXT=$(python3 - "$BOX" <<'PY'
import email, os, sys
box = sys.argv[1]
m = email.message_from_bytes(open(os.path.join(box, sorted(os.listdir(box))[-1]), 'rb').read())
print(''.join(p.get_payload(decode=True).decode('utf-8', 'ignore') for p in m.walk() if p.get_content_type() == 'text/plain'))
PY
)
assert_eq "the statement greets the contact (was: Sehr geehrte/r $TAG Weber KG,)" "$(head -1 <<<"$TEXT" | tr -d '\r')" "Sehr geehrte Frau Weber,"

note "=== 4. the invoice e-mail, and in English ==="
AS GET "/api/v1/invoices/$I_FRAU/email-data?companyId=$C"
assert_eq "the invoice e-mail: Sehr geehrte Frau Weber (was: Sehr geehrte/r Frau Weber)" "$(P "d['body'].split(chr(10))[0]")" "Sehr geehrte Frau Weber,"
LINE=$(cd "$SCRIPT_DIR/.." && npx ts-node -T -e "import { greetingLine } from './src/modules/mail/templates/invoice-email.template'; console.log(greetingLine('en', { name: 'X', type: 'business', contact: { name: 'Herr Dr. Schmidt' } }))" 2>/dev/null)
assert_eq "…in English: Dear Mr Dr. Schmidt" "$LINE" "Dear Mr Dr. Schmidt"

summary
