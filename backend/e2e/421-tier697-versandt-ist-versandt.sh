#!/bin/bash
# Tier 697 — an invoice e-mailed to the customer is no longer edited or deleted
#
# An issued invoice may be edited or deleted on its issue day (Tier 477; not
# once a payment or a credit note is booked on it). The edit drops the kept
# copy and the next way out makes a new one (Tier 497 / 684). Measured with
# the test mailbox: an invoice over 1 × 100 € issued and e-mailed, then edited
# the same day to 5 × 100 € — 200; the PDF, the XRechnung and the archive
# showed the 595 € version, the customer held the 119 € one: two documents
# under one number, and the one received gone from the archive (§ 147 AO).
# Deleting it the same day left the customer an invoice that no longer
# existed — its tax is owed all the same (§ 14c UStG).
# Now an issued invoice delivered by the company's mail server is refused
# both, with the address and the time it went out; it is corrected by a
# credit note, as on any later day. Not sent (or only offered in the mail
# client without a server): as before.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-421-$(date +%s%N | cut -c1-13)"
TODAY=$(TZ=Europe/Berlin date +%F)
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
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier697-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C" DE123456789
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
says() { grep -q "$1" <<<"$BODY" && echo yes || echo "no: $BODY"; }
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde AG\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"},\"contact\":{\"email\":\"buchhaltung@kunde.example.test\"}}"
K=$(json_field "$BODY" id)
line() { echo "{\"description\":\"$1\",\"quantity\":$2,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}"; }
issued() { # → INV, issued today
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[$(line Altposition 1)]}"
  INV=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$INV/status?companyId=$C" '{"status":"sent"}'
}
total() { q "select total from \"Invoice\" where id='$1'"; }
edit() { AS PUT "/api/v1/invoices/$1?companyId=$C" "{\"items\":[$(line Neuposition 5)]}"; }

note "=== 1. not sent: edited and deleted on its day, as before ==="
issued; A=$INV
edit "$A"
assert_eq "edited (Tier 477)" "$STATUS/$(total "$A")" "200/595.0000"
AS DELETE "/api/v1/invoices/$A?companyId=$C"
assert_eq "deleted (the last number, its day)" "$STATUS/$(q "select count(*) from \"Invoice\" where id='$A'")" "200/0"

note "=== 2. offered in the mail client only (no mail server): as before ==="
issued; B=$INV
AS POST "/api/v1/invoices/$B/send-email?companyId=$C" '{}'
assert_eq "no server: the send is 'opened', not 'sent'" "$(q "select string_agg(status, ',') from \"EmailSend\" where \"invoiceId\"='$B'")" "opened"
edit "$B"
assert_eq "…still edited" "$STATUS" "200"

note "=== 3. delivered by the company's mail server: no edit, no delete ==="
AS PUT "/api/v1/mail/config?companyId=$C" "{\"smtpHost\":\"127.0.0.1\",\"smtpPort\":$PORT,\"smtpSecure\":false,\"smtpUser\":\"u\",\"smtpPassword\":\"p\",\"fromEmail\":\"rechnung@example.test\",\"fromName\":\"$TAG\",\"enabled\":true}"
issued; S=$INV
AS POST "/api/v1/invoices/$S/send-email?companyId=$C" '{}'
assert_eq "sent: 201, one message in the mailbox" "$STATUS/$(ls "$BOX" 2>/dev/null | wc -l | tr -d ' ')" "201/1"
edit "$S"
assert_eq "an edit after sending: 403 (was 200, the 595 € version)" "$STATUS/$(total "$S")" "403/119.0000"
assert_eq "…the answer names the address and the credit note" "$(says buchhaltung@kunde.example.test)/$(says Gutschrift)" "yes/yes"
AS DELETE "/api/v1/invoices/$S?companyId=$C"
assert_eq "a delete after sending: 403 (was 200)" "$STATUS/$(q "select count(*) from \"Invoice\" where id='$S'")" "403/1"
AS GET "/api/v1/invoices/$S?companyId=$C"
assert_eq "the invoice says where it went (the page shows no edit / delete)" "$(echo "$BODY" | python3 -c "import sys,json;print(json.load(sys.stdin)['sentToCustomer']['to'])")" "buchhaltung@kunde.example.test"
AS GET "/api/v1/invoices/$B?companyId=$C"
assert_eq "…the one only offered in the mail client does not" "$(echo "$BODY" | python3 -c "import sys,json;print(json.load(sys.stdin)['sentToCustomer'])")" "None"
AS POST "/api/v1/invoices/$S/credit-note?companyId=$C" '{"reason":"Storno"}'
assert_eq "the way: a Storno credit note" "$STATUS" "201"

note "=== 4. a draft written today is still a draft ==="
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",\"items\":[$(line Entwurf 1)]}"
D=$(json_field "$BODY" id); edit "$D"
assert_eq "a draft is edited" "$STATUS" "200"

summary
