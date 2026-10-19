#!/bin/bash
# Tier 685 — an issued invoice is handed out as its kept copy
#
# The owner, 14.10.2026: „要，已开具的发票一律提供存档原件“ — an issued invoice is
# always handed out as its archived original.
#
# Measured before: an invoice issued at "Altstraße 1" with IBAN …3000; then the
# company moved and changed its bank. Downloaded again, as …/zugferd, in the
# ZIP, e-mailed again, opened in the customer portal: every copy showed
# "Neustraße 9" and the new IBAN — rendered again from today's master data —
# while the archive (Tier 684) held the original.
#
# Now every way out hands out the kept copy; ?format=pdf is that copy without
# the XML (not a new rendering). A draft, and a quote, are rendered as they are.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-409-$(date +%s%N | cut -c1-13)"
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
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier685-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
fetch() { curl -sS -o "$2" -w "%{http_code}" -H "x-user-id: $U" -H "x-company-id: $C" "$API$1"; }
# where FILE → "einvoice|plain|none" + which address and IBAN the page shows: old / new / both / neither
where() {
  # Tier 693: the invoice PDF embeds its fonts — its text through pdf.js
  node "$SCRIPT_DIR/fixtures/pdf-text.mjs" "$1" > "$WORK/doc.txt" 2>/dev/null || : > "$WORK/doc.txt"
  DOC_TXT="$WORK/doc.txt" python3 - "$1" <<'PY'
import os, re, sys, zlib
try: d = open(sys.argv[1], 'rb').read()
except OSError: d = b''
if d[:4] != b'%PDF': print('none'); sys.exit(0)
cii = False
text = open(os.environ['DOC_TXT'], encoding='utf-8').read()
for m in re.finditer(rb'stream\r?\n(.*?)endstream', d, re.DOTALL):
    try: dec = zlib.decompressobj().decompress(m.group(1))
    except Exception: continue
    if b'CrossIndustryInvoice' in dec: cii = True
def which(old, new):
    o, n = old in text, new in text
    return 'both' if o and n else 'old' if o else 'new' if n else 'neither'
print(' '.join(['einvoice' if cii else 'plain', which('Altstra', 'Neustra'), which('DE89370400440532013000', 'DE02120300000000202051'), 'factur-x' if b'factur-x' in d else 'no-factur-x']))
PY
}
attachment() { # NAME OUT → the newest message's attachment of that name
  python3 - "$BOX" "$1" "$2" <<'PY'
import email, os, sys
box, name, out = sys.argv[1:4]
files = sorted(os.listdir(box)) if os.path.isdir(box) else []
if not files: sys.exit(1)
m = email.message_from_bytes(open(os.path.join(box, files[-1]), 'rb').read())
for part in m.walk():
    if part.get_filename() == name:
        open(out, 'wb').write(part.get_payload(decode=True)); sys.exit(0)
sys.exit(1)
PY
}

AS PUT "/api/v1/companies/$C?companyId=$C" '{"vatId":"DE123456789","email":"info@t685.example","phone":"+49 30 1","address":{"street":"Altstraße 1","city":"Berlin","postalCode":"10115","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX","bankName":"Alte Bank"}}'
AS PUT "/api/v1/mail/config?companyId=$C" "{\"smtpHost\":\"127.0.0.1\",\"smtpPort\":$PORT,\"smtpSecure\":false,\"smtpUser\":\"u\",\"smtpPassword\":\"p\",\"fromEmail\":\"rechnung@example.test\",\"fromName\":\"$TAG\",\"enabled\":true}"
KMAIL="kunde-$TAG@example.test"
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"Kunde AG\",\"type\":\"business\",\"vatId\":\"DE987654321\",\"address\":{\"street\":\"Weg 2\",\"city\":\"Hamburg\",\"postalCode\":\"20095\",\"country\":\"DE\"},\"contact\":{\"email\":\"$KMAIL\"}}"
K=$(P "d['id']")
mk() { AS POST "/api/v1/invoices?companyId=$C" "{${2:+\"type\":\"$2\",}\"customerId\":\"$K\",\"issueDate\":\"2026-10-01\",\"items\":[{\"description\":\"$1\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"; ID=$(P "d['id']"); NR=$(P "d['invoiceNumber']"); }
mk "Beratung";  INV=$ID; NUM=$NR
AS POST "/api/v1/invoices/$INV/send-email?companyId=$C" '{}'
SEND=$(P "d['emailSendId']")
attachment "$NUM.pdf" "$WORK/first.pdf"
assert_eq "fixture: issued and sent at the old address with the old IBAN" "$STATUS $(where "$WORK/first.pdf")" "201 einvoice old old factur-x"
mk "Entwurf";   DRAFT=$ID
mk "Angebot" QU; QUOTE=$ID

note "=== the company moves and changes its bank ==="
AS PUT "/api/v1/companies/$C?companyId=$C" '{"address":{"street":"Neustraße 9","city":"Hamburg","postalCode":"20095","country":"DE"},"bankInfo":{"iban":"DE02120300000000202051","bic":"BYLADEM1001","bankName":"Neue Bank"}}'
assert_eq "fixture: moved" "$STATUS" "200"

note "=== the issued invoice, every way out ==="
W="einvoice old old factur-x" # the e-invoice, with the address and IBAN it was issued with
# (unsigned: the download signs on request, Tier 165 — a signature is a layer on top of the copy)
assert_eq "download (was: Neustraße and the new IBAN)" "$(fetch "/api/v1/invoices/$INV/pdf?companyId=$C&sign=false" "$WORK/pdf.pdf") $(where "$WORK/pdf.pdf")" "200 $W"
assert_eq "…byte for byte what the customer was sent" "$(cmp -s "$WORK/pdf.pdf" "$WORK/first.pdf" && echo same || echo differ)" "same"
assert_eq "GET …/zugferd (was: new)" "$(fetch "/api/v1/invoices/$INV/zugferd?companyId=$C" "$WORK/zugferd.pdf") $(where "$WORK/zugferd.pdf")" "200 $W"
curl -sS -o "$WORK/bulk.zip" -X POST "$API/api/v1/invoices/bulk-download?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" -d "{\"invoiceIds\":[\"$INV\"]}"
(cd "$WORK" && unzip -o -q bulk.zip "$NUM.pdf" 2>/dev/null && mv "$NUM.pdf" bulk.pdf)
assert_eq "the bulk ZIP (was: new)" "$(where "$WORK/bulk.pdf")" "$W"
AS POST "/api/v1/mail/emails/$SEND/resend?companyId=$C" '{}'
attachment "$NUM.pdf" "$WORK/resend.pdf"
assert_eq "e-mailed again (was: new)" "$STATUS $(where "$WORK/resend.pdf")" "201 $W"
AS POST "/api/v1/invoices/$INV/send-email?companyId=$C" '{}'
attachment "$NUM.pdf" "$WORK/again.pdf"
assert_eq "sent once more from the invoice (was: new)" "$STATUS $(where "$WORK/again.pdf")" "201 $W"
# Tier 703: the company sends the portal link (a customer can no longer ask for one)
kid=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "select id from \"Customer\" where \"companyId\"='$C' and contact->>'email'='$KMAIL' limit 1")
AS POST "/api/v1/customer-portal/admin/create-session?companyId=$C" "{\"customerId\":\"$kid\"}"
TOKEN=$(python3 - "$BOX" <<'PY'
import email, os, re, sys
files = sorted(os.listdir(sys.argv[1]))
m = email.message_from_bytes(open(os.path.join(sys.argv[1], files[-1]), 'rb').read())
body = ''.join(p.get_payload(decode=True).decode('utf-8', 'ignore') for p in m.walk() if p.get_content_type() == 'text/plain')
t = re.search(r'token=([0-9a-f]{64})', body); print(t.group(1) if t else '')
PY
)
curl -sS -o "$WORK/portal.pdf" "$API/api/v1/customer-portal/invoice/$INV/pdf?token=$TOKEN"
assert_eq "the customer portal (was: new)" "$(where "$WORK/portal.pdf")" "$W"
assert_eq "?format=pdf: the same copy without the XML — not a new rendering (was: new)" \
  "$(fetch "/api/v1/invoices/$INV/pdf?companyId=$C&format=pdf" "$WORK/plain.pdf") $(where "$WORK/plain.pdf")" "200 plain old old no-factur-x"
pages() { (cd "$SCRIPT_DIR/.." && node -e "require('pdf-lib').PDFDocument.load(require('fs').readFileSync(process.argv[1])).then(d => console.log(d.getPageCount(), d.getAttachments ? 'x' : ''), e => console.log('broken'))" "$1" | cut -d' ' -f1); }
assert_eq "…a PDF that opens, with as many pages as the copy" "$(pages "$WORK/plain.pdf")" "$(pages "$WORK/first.pdf")"

note "=== what is not issued is rendered as it is ==="
assert_eq "a draft shows the new address and IBAN" "$(fetch "/api/v1/invoices/$DRAFT/pdf?companyId=$C" "$WORK/draft.pdf") $(where "$WORK/draft.pdf")" "200 einvoice new new factur-x"
assert_eq "a quote too (no invoice)" "$(fetch "/api/v1/invoices/$QUOTE/pdf?companyId=$C" "$WORK/quote.pdf") $(where "$WORK/quote.pdf" | cut -d' ' -f1-3)" "200 plain new new"

note "=== a copy whose file is gone is made again, and said so ==="
FILE=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "select \"pdfPath\" from \"Invoice\" where id='$INV'")
docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "update \"Invoice\" set \"pdfPath\"='pdf/gone/$INV.pdf' where id='$INV'" >/dev/null
assert_eq "download: 200, a new copy (with today's data — the original is lost)" \
  "$(fetch "/api/v1/invoices/$INV/pdf?companyId=$C" "$WORK/remade.pdf") $(where "$WORK/remade.pdf") $(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "select \"pdfPath\" not in ('pdf/gone/$INV.pdf', '$FILE') from \"Invoice\" where id='$INV'")" \
  "200 einvoice new new factur-x t"

summary
