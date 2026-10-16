#!/bin/bash
# Tier 689 — a credit note, a receipt and a proforma each go out with their own text
#
# Measured before (the e-mail as the customer received it):
#   credit note  "Rechnung CN-…" — "anbei erhalten Sie die Rechnung CN-… über
#                -119,00 €. Bitte begleichen Sie den Betrag bis zum …"
#   receipt      "Bitte begleichen Sie den Betrag" — for what is paid
#   proforma     "Rechnung PI-…"
# and a customer named "Müller & Söhne" was written "Müller &amp; Söhne": the
# plain-text e-mail HTML-escaped the name. The send dialog's prefilled text
# (the page's own table) had the same gaps; GET /invoices/:id/email-data wrote
# a text of its own ("über EUR -119.00").
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-413-$(date +%s%N | cut -c1-13)"
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
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier689-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
# mail → "subject|body" of the newest message (body lines joined with " / ")
mail() {
  python3 - "$BOX" <<'PY'
import email, os, sys
from email.header import decode_header, make_header
files = sorted(os.listdir(sys.argv[1]))
m = email.message_from_bytes(open(os.path.join(sys.argv[1], files[-1]), 'rb').read())
subj = str(make_header(decode_header(m['Subject'] or '')))
body = ''.join(p.get_payload(decode=True).decode(p.get_content_charset() or 'utf-8', 'ignore') for p in m.walk() if p.get_content_type() == 'text/plain')
print(subj + '|' + ' / '.join(l for l in body.replace('\r', '').split('\n') if l.strip()))
PY
}

AS PUT "/api/v1/companies/$C?companyId=$C" '{"vatId":"DE123456789","email":"info@t689.example","phone":"+49 30 1","address":{"street":"Hauptstr. 1","city":"Berlin","postalCode":"10115","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX","bankName":"Bank"}}'
AS PUT "/api/v1/mail/config?companyId=$C" "{\"smtpHost\":\"127.0.0.1\",\"smtpPort\":$PORT,\"smtpSecure\":false,\"smtpUser\":\"u\",\"smtpPassword\":\"p\",\"fromEmail\":\"rechnung@example.test\",\"fromName\":\"$TAG\",\"enabled\":true}"
AS POST "/api/v1/customers?companyId=$C" '{"name":"Müller & Söhne","type":"business","vatId":"DE987654321","address":{"street":"Weg 2","city":"Hamburg","postalCode":"20095","country":"DE"},"contact":{"email":"mueller@example.test","name":"Müller & Söhne"}}'
K=$(P "d['id']") # (Tier 691: greeted by the contact person's name — a company without one is "Damen und Herren")
TODAY=$(TZ=Europe/Berlin date +%F)
mk() { AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",${1:+\"type\":\"$1\",}\"issueDate\":\"$TODAY\",\"items\":[{\"description\":\"Beratung\",\"quantity\":1,\"unit\":\"Std\",\"unitPrice\":100,\"vatRate\":0.19}]}"; P "d['id']"; }
INV=$(mk); AS PUT "/api/v1/invoices/$INV/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$INV/credit-note?companyId=$C" '{"reason":"Storno"}'
CN=$(P "d['id']"); CNNR=$(P "d['invoiceNumber']")
RCV=$(mk RCV); PI=$(mk PI)
[[ -n "$INV" && -n "$CN" && -n "$RCV" && -n "$PI" ]] && pass "fixture: an invoice, its credit note, a receipt, a proforma" || fail "fixtures"

note "=== 1. what the customer receives ==="
AS POST "/api/v1/invoices/$INV/send-email?companyId=$C" '{}'
M=$(mail)
assert_eq "the invoice: as before, and the name as typed (was: Müller &amp; Söhne)" \
  "$STATUS $(grep -c '^Rechnung ' <<<"$M") $(grep -c 'Sehr geehrte/r Müller & Söhne, / anbei erhalten Sie die Rechnung' <<<"$M") $(grep -c '&amp;' <<<"$M")" "201 1 1 0"
AS POST "/api/v1/invoices/$CN/send-email?companyId=$C" '{}'
M=$(mail)
assert_eq "the credit note: called a Gutschrift, the amount positive, no request to pay (was: „Rechnung … -119,00 € … begleichen“)" \
  "$STATUS ${M%%|*} / $(grep -c 'unsere Gutschrift' <<<"$M") $(grep -c '119,00' <<<"$M") $(grep -c -- '-119' <<<"$M") $(grep -c 'begleichen' <<<"$M")" \
  "201 Gutschrift $CNNR von $TAG GmbH / 1 1 0 0"
AS POST "/api/v1/invoices/$RCV/send-email?companyId=$C" '{}'
M=$(mail)
assert_eq "the receipt: paid, not to be paid (was: „Bitte begleichen Sie den Betrag“)" \
  "$STATUS $(grep -c '^Quittung ' <<<"$M") $(grep -c 'Der Betrag ist bezahlt' <<<"$M") $(grep -c 'begleichen' <<<"$M")" "201 1 1 0"
AS POST "/api/v1/invoices/$PI/send-email?companyId=$C" '{}'
M=$(mail)
assert_eq "the proforma: named so, with the amount to transfer" "$STATUS $(grep -c '^Proforma-Rechnung ' <<<"$M") $(grep -c 'Bitte überweisen Sie den Betrag' <<<"$M")" "201 1 1"
AS POST "/api/v1/invoices/$CN/send-email?companyId=$C" '{"language":"en"}'
assert_eq "…in English too" "$(mail | cut -d'|' -f1)" "Credit note $CNNR from $TAG GmbH"

note "=== 2. GET /invoices/:id/email-data uses the same text ==="
AS GET "/api/v1/invoices/$CN/email-data?companyId=$C"
assert_eq "the credit note's (was: „Rechnung … über EUR -119.00 … begleichen“)" \
  "$STATUS $(P "d['subject']") / $(P "'119,00' in d['body'] and '-119' not in d['body'] and 'begleichen' not in d['body']")" "200 Gutschrift $CNNR von $TAG GmbH / True"

note "=== 3. the send dialog's prefilled text (the page's own table) ==="
PAGE="$SCRIPT_DIR/../../frontend/src/app/dashboard/invoices/[id]/page.tsx"
cat > "$WORK/parity.py" <<'PY'
import re, sys
page, server = (open(f, encoding='utf-8').read() for f in sys.argv[1:3])
def texts(src, typ, indent):
    i = src.index(indent + typ + ': {'); j = src.index('\n' + indent + '},', i)
    return re.findall(r'["\']((?:[^"\'\\]|\\.)*)["\']', src[i:j])
print(all(texts(page, t, '    ') == texts(server, t, '  ') and len(texts(page, t, '    ')) > 20 for t in ('CN', 'RCV', 'PI')))
PY
assert_eq "it has a credit note, a receipt and a proforma, in three languages, as the server" \
  "$(python3 "$WORK/parity.py" "$PAGE" "$SCRIPT_DIR/../src/modules/mail/templates/invoice-email.template.ts")" "True"
assert_eq "…and a credit note's amount is shown positive" "$(grep -c 'Math.abs(parseFloat(invoice' "$PAGE")" "2"

summary
