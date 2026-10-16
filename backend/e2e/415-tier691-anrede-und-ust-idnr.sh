#!/bin/bash
# Tier 691 — a company is greeted as a company; the VAT id is written as the BZSt writes it
#
# Measured before:
#   - every e-mail to a company began "Sehr geehrte/r Kunde GmbH," — the
#     customer's contact person (contact.name, which the reminders use) was
#     not looked at, and a company without one is "Sehr geehrte Damen und
#     Herren" in German business letters;
#   - the invoice PDF labelled the customer's VAT id "UST-IDNr.:" and the own
#     one "USt-IDNr.:" — the abbreviation is "USt-IdNr.".
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-415-$(date +%s%N | cut -c1-13)"
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
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier691-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
first_line() { # the newest message's first body line
  python3 - "$BOX" <<'PY'
import email, os, sys
files = sorted(os.listdir(sys.argv[1]))
m = email.message_from_bytes(open(os.path.join(sys.argv[1], files[-1]), 'rb').read())
body = ''.join(p.get_payload(decode=True).decode(p.get_content_charset() or 'utf-8', 'ignore') for p in m.walk() if p.get_content_type() == 'text/plain')
print([l for l in body.replace('\r', '').split('\n') if l.strip()][0])
PY
}
AS PUT "/api/v1/companies/$C?companyId=$C" '{"vatId":"DE123456789","taxId":"12/345/67890","email":"info@t691.example","address":{"street":"Hauptstr. 1","city":"Berlin","postalCode":"10115","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX"}}'
AS PUT "/api/v1/mail/config?companyId=$C" "{\"smtpHost\":\"127.0.0.1\",\"smtpPort\":$PORT,\"smtpSecure\":false,\"smtpUser\":\"u\",\"smtpPassword\":\"p\",\"fromEmail\":\"rechnung@example.test\",\"fromName\":\"$TAG\",\"enabled\":true}"
cust() { # name type contactName? vatId?
  AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$1\",\"type\":\"$2\"${4:+,\"vatId\":\"$4\"},\"address\":{\"street\":\"Weg 2\",\"city\":\"Hamburg\",\"postalCode\":\"20095\",\"country\":\"DE\"},\"contact\":{\"email\":\"k$RANDOM@example.test\"${3:+,\"name\":\"$3\"}}}"; P "d['id']"
}
send() { # customer [language] → first line of the e-mail
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"$(TZ=Europe/Berlin date +%F)\",\"items\":[{\"description\":\"Beratung\",\"quantity\":1,\"unit\":\"Std\",\"unitPrice\":100,\"vatRate\":0.19}]}"
  local id; id=$(P "d['id']")
  AS POST "/api/v1/invoices/$id/send-email?companyId=$C" "{${2:+\"language\":\"$2\"}}"
  [[ "$STATUS" == "201" ]] && first_line || echo "send $STATUS"
}
FIRM=$(cust "Kunde GmbH" business "" DE987654321)
FIRM_CONTACT=$(cust "Andere GmbH" business "Frau Petra Schmidt")
PERSON=$(cust "Max Mustermann" individual)

note "=== 1. the greeting ==="
assert_eq "a company without a contact person (was: Sehr geehrte/r Kunde GmbH,)" "$(send "$FIRM")" "Sehr geehrte Damen und Herren,"
assert_eq "…in English" "$(send "$FIRM" en)" "Dear Sir or Madam,"
assert_eq "a company with a contact person: the person" "$(send "$FIRM_CONTACT")" "Sehr geehrte/r Frau Petra Schmidt,"
assert_eq "a private customer: by name, as before" "$(send "$PERSON")" "Sehr geehrte/r Max Mustermann,"
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$PERSON\",\"issueDate\":\"$(TZ=Europe/Berlin date +%F)\",\"items\":[{\"description\":\"Beratung\",\"quantity\":1,\"unit\":\"Std\",\"unitPrice\":100,\"vatRate\":0.19}]}"
AS POST "/api/v1/invoices/$(P "d['id']")/send-email?companyId=$C" '{"salutation":"Sehr geehrter Herr"}'
assert_eq "a salutation picked in the dialog is used with the name" "$(first_line)" "Sehr geehrter Herr Max Mustermann,"

note "=== 2. the VAT id on the invoice ==="
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$FIRM\",\"issueDate\":\"$(TZ=Europe/Berlin date +%F)\",\"items\":[{\"description\":\"Beratung\",\"quantity\":1,\"unit\":\"Std\",\"unitPrice\":100,\"vatRate\":0.19}]}"
I=$(P "d['id']")
curl -sS -o "$WORK/i.pdf" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$I/pdf?companyId=$C&sign=false"
T=$(node "$SCRIPT_DIR/fixtures/pdf-text.mjs" "$WORK/i.pdf") # Tier 693: through pdf.js (embedded fonts)
assert_eq "„USt-IdNr.“ for the customer's and the own (was: UST-IDNr. / USt-IDNr.)" \
  "$(grep -o 'USt-IdNr\.:' <<<"$T" | wc -l | tr -d ' ') $(grep -o 'UST-IDNr' <<<"$T" | wc -l | tr -d ' ') $(grep -o 'USt-IDNr' <<<"$T" | wc -l | tr -d ' ')" "2 0 0"

note "=== 3. the send dialog greets the same way ==="
PAGE="$SCRIPT_DIR/../../frontend/src/app/dashboard/invoices/[id]/page.tsx"
assert_eq "it uses the same rule (greetingOf), in both places it fills the text" "$(grep -c 'greetingOf(lang)' "$PAGE") $(grep -c ': "Sehr geehrte Damen und Herren", customerName: ""' "$PAGE")" "2 1"

summary
