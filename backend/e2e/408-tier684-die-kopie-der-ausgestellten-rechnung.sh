#!/bin/bash
# Tier 684 — the copy of an invoice is made when it is issued
#
# The stored PDF (`pdfPath`) is what the DATEV bundle and the GoBD export hand
# over as the invoice "as issued" (Tier 420, 497). It was written in one place
# only: the first download. Now it is made when the invoice is issued; every
# way out and both exports make it for an invoice that still has none. Measured on three issued invoices — one sent to
# the customer by e-mail, one downloaded, one only issued: the DATEV bundle
# held one Beleg, the GoBD export one PDF and two bare meta.json. The invoice
# the customer actually has was not kept (§ 14b UStG).
#
# Also: the first download with ?format=pdf stored the plain variant as "the
# issued invoice" — the copy is the e-invoice now. And the XML of a credit note
# sent again or read in the customer portal did not name the invoice it
# corrects (BG-3): those two loaded the document without it.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-408-$(date +%s%N | cut -c1-13)"
WORK=$(mktemp -d); BOX="$WORK/box"
# (all three streams away from the spec's own: a mailbox that outlived the spec
# would otherwise hold the suite runner's pipe open)
python3 "$SCRIPT_DIR/fixtures/smtp-sink.py" "$BOX" > "$WORK/port" 2> "$WORK/sink.err" < /dev/null &
SINK=$!
trap '{ kill $SINK; wait $SINK; } 2>/dev/null; rm -rf "$WORK"' EXIT
for _ in $(seq 1 50); do [[ -s "$WORK/port" ]] && break; python3 -c "import time; time.sleep(0.1)"; done
PORT=$(cat "$WORK/port")
[[ -n "$PORT" ]] && pass "fixture: a mailbox on 127.0.0.1:$PORT" || { fail "the mailbox did not start"; summary; exit 1; }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier684-e2e\",\"companyName\":\"$TAG GmbH\"}" \
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
kept() { q "select case when \"pdfPath\" is null then 'none' else 'kept' end from \"Invoice\" where id='$1'"; }
# doc FILE needle… → "einvoice|plain|none" and, per needle, + (on the page) or -
doc() {
  # Tier 693: the invoice PDF embeds its fonts — its text through pdf.js
  node "$SCRIPT_DIR/fixtures/pdf-text.mjs" "$1" > "$WORK/doc.txt" 2>/dev/null || : > "$WORK/doc.txt"
  DOC_TXT="$WORK/doc.txt" python3 - "$@" <<'PY'
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
print(' '.join(['einvoice' if cii else 'plain'] + [('+' if n in text else '-') for n in sys.argv[2:]]))
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
names() { python3 -c "import sys,zipfile; print(' '.join(sorted(n for n in zipfile.ZipFile(sys.argv[1]).namelist() if sys.argv[2] in n and n.endswith('.pdf'))))" "$1" "$2" 2>/dev/null; }

AS PUT "/api/v1/companies/$C?companyId=$C" '{"vatId":"DE123456789","email":"info@t684.example","phone":"+49 30 1","address":{"street":"Hauptstr. 1","city":"Berlin","postalCode":"10115","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX","bankName":"Bank"}}'
AS PUT "/api/v1/mail/config?companyId=$C" "{\"smtpHost\":\"127.0.0.1\",\"smtpPort\":$PORT,\"smtpSecure\":false,\"smtpUser\":\"u\",\"smtpPassword\":\"p\",\"fromEmail\":\"rechnung@example.test\",\"fromName\":\"$TAG\",\"enabled\":true}"
KMAIL="kunde-$TAG@example.test"
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"Kunde AG\",\"type\":\"business\",\"vatId\":\"DE987654321\",\"address\":{\"street\":\"Weg 2\",\"city\":\"Hamburg\",\"postalCode\":\"20095\",\"country\":\"DE\"},\"contact\":{\"email\":\"$KMAIL\"}}"
K=$(P "d['id']")
invoice() { AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-10-01\",\"items\":[{\"description\":\"$1\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"; ID=$(P "d['id']"); NR=$(P "d['invoiceNumber']"); }
issue() { AS PUT "/api/v1/invoices/$1/status?companyId=$C" '{"status":"sent"}'; }
invoice "per E-Mail";        MAIL=$ID;  MAILNR=$NR
invoice "heruntergeladen";   DOWN=$ID;  DOWNNR=$NR;  issue "$DOWN"
invoice "nur ausgestellt";   ONLY=$ID;  ONLYNR=$NR;  issue "$ONLY"
invoice "zuerst ohne XML";   PLAIN=$ID; PLAINNR=$NR; issue "$PLAIN"
invoice "ein Entwurf";       DRAFT=$ID; DRAFTNR=$NR
[[ -n "$MAIL" && -n "$DOWN" && -n "$ONLY" && -n "$PLAIN" && -n "$DRAFT" ]] && pass "fixture: four issued invoices and a draft" || { fail "invoice fixtures"; summary; exit 1; }

note "=== 1. the copy is kept when the invoice goes out ==="
assert_eq "an issued invoice nobody has taken out yet has its copy (was: none until a download)" "$(kept "$ONLY")" "kept"
assert_eq "a draft has none" "$(kept "$MAIL")" "none"
AS POST "/api/v1/invoices/$MAIL/send-email?companyId=$C" '{}'
assert_eq "sent to the customer by e-mail (which issues it): 201, and the copy is kept (was: none)" "$STATUS $(kept "$MAIL")" "201 kept"
assert_eq "a draft's PDF is never kept (Tier 497)" "$(fetch "/api/v1/invoices/$DRAFT/pdf?companyId=$C" "$WORK/draft.pdf") $(kept "$DRAFT")" "200 none"
# an invoice whose copy is gone (issued before this tier, or the file's row was reset): every way out makes it again
q "update \"Invoice\" set \"pdfPath\"=null where id in ('$DOWN','$PLAIN','$ONLY')" >/dev/null
# (Tier 685: the copy is made — as the e-invoice — and the plain variant is cut from it; section 2 reads the copy)
assert_eq "the plain variant asked for first: a PDF without XML; the copy kept is not it (was: kept as the issued invoice)" \
  "$(fetch "/api/v1/invoices/$PLAIN/pdf?companyId=$C&format=pdf" "$WORK/plain.pdf") $(doc "$WORK/plain.pdf") $(kept "$PLAIN")" "200 plain kept"
assert_eq "the download keeps the e-invoice" "$(fetch "/api/v1/invoices/$DOWN/pdf?companyId=$C" "$WORK/down.pdf") $(doc "$WORK/down.pdf") $(kept "$DOWN")" "200 einvoice kept"

note "=== 2. the DATEV bundle has a Beleg for every issued invoice ==="
assert_eq "bundle: 200" "$(fetch "/api/v1/reports/datev-export-bundle?companyId=$C&startDate=2026-10-01&endDate=2026-10-31" "$WORK/datev.zip")" "200"
assert_eq "all four issued invoices are in it, the draft is not (was: only the downloaded one)" "$(names "$WORK/datev.zip" Belegbilder/)" \
  "Belegbilder/$MAILNR.pdf Belegbilder/$DOWNNR.pdf Belegbilder/$ONLYNR.pdf Belegbilder/$PLAINNR.pdf"
assert_eq "the two that had no copy have one now" "$(kept "$ONLY") $(kept "$PLAIN")" "kept kept"
(cd "$WORK" && unzip -o -q datev.zip "Belegbilder/$MAILNR.pdf" "Belegbilder/$PLAINNR.pdf" "Belegbilder/$ONLYNR.pdf")
assert_eq "the Belege are the e-invoices: the one e-mailed, the one first asked for plain, the one only issued" \
  "$(doc "$WORK/Belegbilder/$MAILNR.pdf" "per E-Mail") / $(doc "$WORK/Belegbilder/$PLAINNR.pdf" "zuerst ohne XML") / $(doc "$WORK/Belegbilder/$ONLYNR.pdf" "nur ausgestellt")" \
  "einvoice + / einvoice + / einvoice +"

note "=== 3. the GoBD export has the document, not only its meta.json ==="
invoice "erst im Export"; LATE=$ID; LATENR=$NR; issue "$LATE"
q "update \"Invoice\" set \"pdfPath\"=null where id='$LATE'" >/dev/null
assert_eq "export: 200" "$(fetch "/api/v1/gobd-export?companyId=$C&year=2026&month=10" "$WORK/gobd.zip")" "200"
assert_eq "five issued invoices, five PDFs (was: a PDF for the downloaded ones only)" \
  "$(python3 -c "import sys,zipfile; print(len([n for n in zipfile.ZipFile(sys.argv[1]).namelist() if n.startswith('invoices/') and n.endswith('.pdf')]))" "$WORK/gobd.zip")" "5"
assert_eq "…the draft has none" "$(names "$WORK/gobd.zip" "$DRAFTNR")" ""
assert_eq "the one without a copy got it by the export" "$(kept "$LATE")" "kept"

note "=== 4. a credit note names its invoice, sent again and in the portal too ==="
AS POST "/api/v1/invoices/$DOWN/credit-note?companyId=$C" '{"reason":"Storno"}'
CN=$(P "d['id']"); CNNR=$(P "d['invoiceNumber']")
assert_eq "fixture: a credit note for the downloaded invoice — created issued, with its copy (was: none)" "$STATUS $(kept "$CN")" "201 kept"
AS POST "/api/v1/invoices/$CN/send-email?companyId=$C" '{}'
SEND=$(P "d['emailSendId']")
attachment "$CNNR.pdf" "$WORK/cn-mail.pdf"
assert_eq "the credit note by e-mail names the invoice (as before, now as an e-invoice)" "$STATUS $(doc "$WORK/cn-mail.pdf" "$DOWNNR")" "201 einvoice +"
AS POST "/api/v1/mail/emails/$SEND/resend?companyId=$C" '{}'
attachment "$CNNR.pdf" "$WORK/cn-resend.pdf"
assert_eq "sent again, it does too" "$STATUS $(doc "$WORK/cn-resend.pdf" "$DOWNNR")" "201 einvoice +"
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
curl -sS -o "$WORK/cn-portal.pdf" "$API/api/v1/customer-portal/invoice/$CN/pdf?token=$TOKEN"
assert_eq "…and in the customer portal" "$(doc "$WORK/cn-portal.pdf" "$DOWNNR")" "einvoice +"
xml_names() { # FILE → "<type code found>/<the invoice named in the XML>"
  python3 - "$1" "$DOWNNR" <<'PY'
import re, sys, zlib
d = open(sys.argv[1], 'rb').read(); x = b''
for m in re.finditer(rb'stream\r?\n(.*?)endstream', d, re.DOTALL):
    try: dec = zlib.decompressobj().decompress(m.group(1))
    except Exception: continue
    if b'CrossIndustryInvoice' in dec: x = dec; break
x = x.decode('utf-8', 'ignore')
print('%d/%d' % (x.count('<ram:TypeCode>381</ram:TypeCode>'), x.count('<ram:IssuerAssignedID>%s</ram:IssuerAssignedID>' % sys.argv[2])))
PY
}
assert_eq "the XML of the one sent again: a credit note (381) for that invoice (was: the invoice not named)" "$(xml_names "$WORK/cn-resend.pdf")" "1/1"
assert_eq "the XML of the portal's: the same (was: the invoice not named)" "$(xml_names "$WORK/cn-portal.pdf")" "1/1"

summary
