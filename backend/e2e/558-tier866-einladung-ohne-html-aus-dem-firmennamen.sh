#!/bin/bash
# Tier 866 — a company's name is text in the invitation, and the sender is the sender
#
# The team invitation wrote the company's name into its HTML as it was: a name
# typed as „<a href=…>Jetzt bestätigen</a>“ became a working link in a mail
# the installation sends to any address. And the sender was written as one
# string, `"${fromName}" <${fromEmail}>`: a name with a quote in it put a
# different address into the From line. Measured on Tier 865 through a
# mailbox (fixtures/smtp-sink.py).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-558-$(date +%s%N | cut -c1-13)"
WORK=$(mktemp -d); BOX="$WORK/box"
python3 "$SCRIPT_DIR/fixtures/smtp-sink.py" "$BOX" > "$WORK/port" 2> "$WORK/sink.err" < /dev/null &
SINK=$!
trap '{ kill $SINK; wait $SINK; } 2>/dev/null; rm -rf "$WORK"' EXIT
for _ in $(seq 1 50); do [[ -s "$WORK/port" ]] && break; python3 -c "import time; time.sleep(0.1)"; done
PORT=$(cat "$WORK/port")
[[ -n "$PORT" ]] && pass "fixture: a mailbox on 127.0.0.1:$PORT" || { fail "the mailbox did not start"; summary; exit 1; }
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier866-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }

# the name and the sender name, typed to do harm (JSON built outside "$( )": braces)
NAME='Muster <a href="https://phish.example.test/login">Jetzt bestätigen</a> & Co'
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qc "update \"Company\" set name = \$n\$$NAME\$n\$ where id='$C'" >/dev/null
MAILCFG=$(python3 -c 'import json,sys;print(json.dumps({"smtpHost":"127.0.0.1","smtpPort":int(sys.argv[1]),"smtpSecure":False,"smtpUser":"u","smtpPassword":"p","fromEmail":"team@example.test","fromName":"Muster\" <ceo@bank.example.test>, \"x","enabled":True}))' "$PORT")
AS PUT "/api/v1/mail/config?companyId=$C" "$MAILCFG"
assert_eq "fixture: the company's own mail server" "$STATUS" "200"
AS POST "/api/v1/users/invitations?companyId=$C" "{\"email\":\"neu-$TAG@example.test\",\"role\":\"viewer\"}"
assert_eq "an invitation is sent" "$STATUS" "201"
for _ in $(seq 1 30); do [[ -n "$(ls "$BOX" 2>/dev/null)" ]] && break; python3 -c "import time; time.sleep(0.2)"; done

READ=$(python3 - "$BOX" <<'PY'
import email, os, sys
from email.utils import getaddresses
box = sys.argv[1]
m = email.message_from_bytes(open(os.path.join(box, sorted(os.listdir(box))[-1]), 'rb').read())
html = ''.join(p.get_payload(decode=True).decode(p.get_content_charset() or 'utf-8', 'ignore') for p in m.walk() if p.get_content_type() == 'text/html')
print('links:', html.count('href="https://phish.example.test'))
print('escaped:', int('&lt;a href=&quot;https://phish.example.test/login&quot;&gt;' in html))
print('from:', ' '.join(a for _, a in getaddresses([m['From'] or ''])))
PY
)
assert_eq "the name is no link in the mail (was: a working link)" "$(sed -n 1p <<<"$READ")" "links: 0"
assert_eq "…it is there as text" "$(sed -n 2p <<<"$READ")" "escaped: 1"
assert_eq "the From line has the configured address only (was: ceo@bank.example.test as well)" "$(sed -n 3p <<<"$READ")" "from: team@example.test"
summary
