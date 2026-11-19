#!/bin/bash
# Tier 873 — a company's SMTP password the installation can no longer open stops its mail, with the reason
#
# Since Tier 630 / 855 the SMTP password is stored sealed under
# FINTS_PIN_ENC_KEY. When the key changes (or is lost), the stored value can
# no longer be opened. MailService then skipped the company's own server
# without a word: its invoices went out through the installation's mail server
# (another sender, the company not knowing) — or, without one, ended in „no
# mail server“; in development the send answered success. The settings page
# went on saying „verschlüsselt gespeichert“.
#
# Now the send and the connection test are refused with the reason, and the
# settings report `passwordUnreadable` (the page says to enter it again).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-565-$(date +%s%N | cut -c1-13)"
WORK=$(mktemp -d); BOX="$WORK/box"
python3 "$SCRIPT_DIR/fixtures/smtp-sink.py" "$BOX" > "$WORK/port" 2> "$WORK/sink.err" < /dev/null &
SINK=$!
trap '{ kill $SINK; wait $SINK; } 2>/dev/null; rm -rf "$WORK"' EXIT
for _ in $(seq 1 50); do [[ -s "$WORK/port" ]] && break; python3 -c "import time; time.sleep(0.1)"; done
PORT=$(cat "$WORK/port")
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier873-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" && -n "$PORT" ]] && pass "fixture: a company and a mailbox" || { fail "fixture"; summary; exit 1; }
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
field() { python3 -c "import json,sys
try: print(json.loads(sys.argv[1]).get(sys.argv[2]))
except Exception: print('-')" "$BODY" "$1"; }
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null; }

AS PUT "/api/v1/companies/$C?companyId=$C" '{"vatId":"DE123456789","email":"info@t873.example","phone":"+49 30 1","address":{"street":"Hauptstr. 1","city":"Berlin","postalCode":"10115","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX","bankName":"Bank"}}'
AS PUT "/api/v1/mail/config?companyId=$C" "{\"smtpHost\":\"127.0.0.1\",\"smtpPort\":$PORT,\"smtpSecure\":false,\"smtpUser\":\"u\",\"smtpPassword\":\"p\",\"fromEmail\":\"rechnung@example.test\",\"fromName\":\"$TAG\",\"enabled\":true}"
AS GET "/api/v1/mail/config?companyId=$C"
assert_eq "fixture: the company's own mail server, password readable" "$(field configured) $(field passwordUnreadable)" "True False"
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde 565","type":"business","address":{"street":"Weg 2","city":"Hamburg","postalCode":"20095","country":"DE"},"contact":{"email":"kunde-565@example.test"}}'
K=$(field id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$(TZ=Europe/Berlin date +%F)\",\"items\":[{\"description\":\"Beratung\",\"quantity\":1,\"unit\":\"Std\",\"unitPrice\":100,\"vatRate\":0.19}]}"
I=$(field id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'

note "=== the installation's key changed: the stored value can no longer be opened ==="
# a sealed value of another key (the GCM tag does not fit)
sql "update \"MailConfig\" set \"smtpPassword\" = 'enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA' where \"companyId\"='$C'" >/dev/null
AS GET "/api/v1/mail/config?companyId=$C"
assert_eq "the settings say so (was: „verschlüsselt gespeichert“ only)" "$(field passwordUnreadable)" "True"
AS POST "/api/v1/mail/test?companyId=$C" '{}'
assert_eq "the connection test: refused, with the reason" "$(field message | grep -c 'lässt sich nicht mehr entschlüsseln')" "1"
BEFORE=$(ls "$BOX" 2>/dev/null | wc -l | tr -d ' ')
AS POST "/api/v1/invoices/$I/send-email?companyId=$C" '{}'
assert_eq "sending the invoice: refused, with the reason (was: „sent“ — through another server, or none)" "$STATUS $(field message | grep -c 'Passwort neu eingeben')" "400 1"
assert_eq "…nothing reached any mailbox" "$(ls "$BOX" 2>/dev/null | wc -l | tr -d ' ')" "$BEFORE"

note "=== entered again ==="
AS PUT "/api/v1/mail/config?companyId=$C" "{\"smtpHost\":\"127.0.0.1\",\"smtpPort\":$PORT,\"smtpSecure\":false,\"smtpUser\":\"u\",\"smtpPassword\":\"p\",\"fromEmail\":\"rechnung@example.test\",\"fromName\":\"$TAG\",\"enabled\":true}"
AS GET "/api/v1/mail/config?companyId=$C"
assert_eq "readable again" "$(field passwordUnreadable)" "False"
AS POST "/api/v1/invoices/$I/send-email?companyId=$C" '{}'
assert_eq "the invoice goes out through the company's server" "$([[ "$STATUS" =~ ^20 ]] && echo sent) $(ls "$BOX" 2>/dev/null | wc -l | tr -d ' ')" "sent $((BEFORE + 1))"
summary
