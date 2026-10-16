#!/bin/bash
# Tier 683 — one invoice is one document on every way out; a second invoice
# under the same number can be confirmed
#
# Measured before, the same invoice of a GmbH with a register entry and a
# managing director:
#
#   GET /invoices/:id/pdf       e-invoice (XML inside), register + director
#   GET /invoices/:id/zugferd   e-invoice, register + director, no template
#   bulk download (ZIP)         e-invoice, NO register, NO director, no template
#   e-mail to the customer      plain PDF, NO register, NO director
#   e-mail, sent again          plain PDF, NO register, NO director, no template
#   customer portal             plain PDF, NO register, NO director, no template
#
# The customer — the one an e-invoice is for — got the one copy without the
# XML. "No template" is more than a colour: the § 19 UStG note of a
# Kleinunternehmer is a text of the template, so it was missing wherever the
# template was not resolved.
#
# And: an expense under a supplier's invoice number that is already entered is
# refused (409, Tier 489). The message told the person at the form to confirm
# "mit „confirmDuplicate“" — the name of a field of the API.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-407-$(date +%s%N | cut -c1-13)"
KOSIT_ROOT="$(cd "$SCRIPT_DIR/../../infra/kosit" && pwd)"
JAVA_BIN="$SCRIPT_DIR/../../infra/java/jdk-17.0.13+11/Contents/Home/bin/java"
if [[ ! -x "$JAVA_BIN" ]]; then
  if [[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/java" ]]; then JAVA_BIN="$JAVA_HOME/bin/java"
  else JAVA_BIN=$(command -v java || true); fi
fi
WORK=$(mktemp -d); BOX="$WORK/box"
# (all three streams away from the spec's own: a mailbox that outlived the spec
# would otherwise hold the suite runner's pipe open)
python3 "$SCRIPT_DIR/fixtures/smtp-sink.py" "$BOX" > "$WORK/port" 2> "$WORK/sink.err" < /dev/null &
SINK=$!
trap '{ kill $SINK; wait $SINK; } 2>/dev/null; rm -rf "$WORK"' EXIT
for _ in $(seq 1 50); do [[ -s "$WORK/port" ]] && break; python3 -c "import time; time.sleep(0.1)"; done
PORT=$(cat "$WORK/port")
[[ -n "$PORT" ]] && pass "fixture: a mailbox on 127.0.0.1:$PORT" || { fail "the mailbox did not start"; summary; exit 1; }

register() { # label → sets U C
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier683-e2e\",\"companyName\":\"$TAG $1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
}
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
mailbox() { AS PUT "/api/v1/mail/config?companyId=$C" "{\"smtpHost\":\"127.0.0.1\",\"smtpPort\":$PORT,\"smtpSecure\":false,\"smtpUser\":\"u\",\"smtpPassword\":\"p\",\"fromEmail\":\"rechnung@example.test\",\"fromName\":\"$TAG\",\"enabled\":true}"; }
fetch() { curl -sS -o "$2" -w "%{http_code}" -H "x-user-id: $U" -H "x-company-id: $C" "$API$1"; }
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
# attachment NAME OUT → the newest message's attachment of that name, written to OUT
attachment() {
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
cii_of() { # PDF OUT.xml
  python3 - "$1" "$2" <<'PY'
import re, sys, zlib
d = open(sys.argv[1], 'rb').read()
for m in re.finditer(rb'stream\r?\n(.*?)endstream', d, re.DOTALL):
    try: dec = zlib.decompressobj().decompress(m.group(1))
    except Exception: continue
    if b'CrossIndustryInvoice' in dec:
        open(sys.argv[2], 'wb').write(dec); sys.exit(0)
sys.exit(1)
PY
}
# outlets ID NUMBER CUSTOMER_EMAIL LABEL → $WORK/LABEL-{pdf,zugferd,bulk,mail,resend,portal}.pdf
outlets() {
  local id="$1" num="$2" mail="$3" l="$4"
  fetch "/api/v1/invoices/$id/pdf?companyId=$C" "$WORK/$l-pdf.pdf" >/dev/null
  fetch "/api/v1/invoices/$id/zugferd?companyId=$C" "$WORK/$l-zugferd.pdf" >/dev/null
  curl -sS -o "$WORK/$l.zip" -X POST "$API/api/v1/invoices/bulk-download?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" -d "{\"invoiceIds\":[\"$id\"]}"
  (cd "$WORK" && unzip -o -q "$l.zip" "$num.pdf" 2>/dev/null && mv "$num.pdf" "$l-bulk.pdf")
  AS POST "/api/v1/invoices/$id/send-email?companyId=$C" '{}'
  SENT_STATUS=$STATUS; SENT_EINVOICE=$(P "d.get('eInvoice')"); local sendId; sendId=$(P "d['emailSendId']")
  attachment "$num.pdf" "$WORK/$l-mail.pdf"
  AS POST "/api/v1/mail/emails/$sendId/resend?companyId=$C" '{}'
  attachment "$num.pdf" "$WORK/$l-resend.pdf"
  curl -sS -o /dev/null -X POST "$API/api/v1/customer-portal/request-session?email=$mail"
  local token; token=$(python3 - "$BOX" <<'PY'
import email, os, re, sys
files = sorted(os.listdir(sys.argv[1]))
m = email.message_from_bytes(open(os.path.join(sys.argv[1], files[-1]), 'rb').read())
body = ''.join(p.get_payload(decode=True).decode('utf-8', 'ignore') for p in m.walk() if p.get_content_type() == 'text/plain')
t = re.search(r'token=([0-9a-f]{64})', body); print(t.group(1) if t else '')
PY
)
  curl -sS -o "$WORK/$l-portal.pdf" "$API/api/v1/customer-portal/invoice/$id/pdf?token=$token"
}

note "=== 1. a GmbH: the same document on six ways out ==="
register gmbh
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"vatId":"DE123456789","email":"info@t683.example","phone":"+49 30 1","registerEntry":"HRB 4711 Amtsgericht Musterstadt","managingDirector":"Gisela Vorstand","address":{"street":"Hauptstr. 1","city":"Berlin","postalCode":"10115","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX","bankName":"Bank"}}'
mailbox
assert_eq "fixture: the company sends through the mailbox" "$STATUS" "200"
KMAIL="kunde-$TAG@example.test"
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"Kunde AG\",\"type\":\"business\",\"vatId\":\"DE987654321\",\"address\":{\"street\":\"Weg 2\",\"city\":\"Hamburg\",\"postalCode\":\"20095\",\"country\":\"DE\"},\"contact\":{\"email\":\"$KMAIL\"}}"
K=$(P "d['id']")
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-10-01\",\"skontoPercent\":2,\"skontoDays\":10,\"items\":[{\"description\":\"Beratung\",\"quantity\":3,\"unit\":\"Std\",\"unitPrice\":120,\"vatRate\":0.19},{\"description\":\"Fachbuch\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":40,\"vatRate\":0.07}]}"
INV=$(P "d['id']"); NUM=$(P "d['invoiceNumber']")
AS PUT "/api/v1/invoices/$INV/status?companyId=$C" '{"status":"sent"}'
assert_eq "fixture: an issued invoice at two rates, with Skonto" "$STATUS" "200"
outlets "$INV" "$NUM" "$KMAIL" g
WANT="einvoice + + +" # the XML inside; the register entry, the managing director, a line of the invoice
assert_eq "the download: an e-invoice with the full letterhead (as before)" "$(doc "$WORK/g-pdf.pdf" "HRB 4711" "Gisela Vorstand" "Beratung")" "$WANT"
assert_eq "GET …/zugferd: the same" "$(doc "$WORK/g-zugferd.pdf" "HRB 4711" "Gisela Vorstand" "Beratung")" "$WANT"
assert_eq "the ZIP of the bulk download: the same (was: no register entry, no managing director)" "$(doc "$WORK/g-bulk.pdf" "HRB 4711" "Gisela Vorstand" "Beratung")" "$WANT"
assert_eq "the e-mail to the customer: 201, and it says an e-invoice went out" "$SENT_STATUS $SENT_EINVOICE" "201 True"
assert_eq "…its attachment: the same (was: a plain PDF without the XML, no register entry, no managing director)" "$(doc "$WORK/g-mail.pdf" "HRB 4711" "Gisela Vorstand" "Beratung")" "$WANT"
assert_eq "the e-mail sent again: the same (was: plain, without them)" "$(doc "$WORK/g-resend.pdf" "HRB 4711" "Gisela Vorstand" "Beratung")" "$WANT"
assert_eq "the customer portal: the same (was: plain, without them)" "$(doc "$WORK/g-portal.pdf" "HRB 4711" "Gisela Vorstand" "Beratung")" "$WANT"
if [[ -n "$JAVA_BIN" && -x "$JAVA_BIN" ]] && cii_of "$WORK/g-mail.pdf" "$WORK/mail.xml"; then
  OUT="$WORK/kosit"; mkdir -p "$OUT"
  if (cd "$OUT" && "$JAVA_BIN" -jar "$KOSIT_ROOT/validator.jar" -r "$KOSIT_ROOT/repository" -s "$KOSIT_ROOT/scenarios.xml" -o "$OUT" "$WORK/mail.xml" >/dev/null 2>&1); then
    pass "what the customer received passes KoSIT (CII D16B schema, EN 16931 rules)"
  else
    fail "what the customer received is rejected by KoSIT: $(grep -oh 'failed-assert[^>]*id="[^"]*"' "$OUT"/*.xml 2>/dev/null | head -5 | tr '\n' ' ')"
  fi
  assert_eq "…and states the invoice: number, gross amount, Skonto" \
    "$(grep -c "<ram:ID>$NUM</ram:ID>" "$WORK/mail.xml")/$(grep -c '<ram:GrandTotalAmount>471.20</ram:GrandTotalAmount>' "$WORK/mail.xml")/$(grep -c 'SKONTO' "$WORK/mail.xml" | sed 's/^[1-9][0-9]*$/1/')" "1/1/1"
else
  fail "no Java for KoSIT, or no XML in the e-mailed invoice"
fi

note "=== 2. a quote is no invoice: a plain PDF, by e-mail too ==="
AS POST "/api/v1/invoices?companyId=$C" "{\"type\":\"QU\",\"customerId\":\"$K\",\"issueDate\":\"2026-10-01\",\"items\":[{\"description\":\"Angebot Beratung\",\"quantity\":1,\"unit\":\"Std\",\"unitPrice\":120,\"vatRate\":0.19}]}"
QU=$(P "d['id']"); QNUM=$(P "d['invoiceNumber']")
AS POST "/api/v1/invoices/$QU/send-email?companyId=$C" '{}'
QSENT="$STATUS $(P "d.get('eInvoice')")"
attachment "$QNUM.pdf" "$WORK/quote.pdf"
assert_eq "the quote by e-mail: 201, no e-invoice; a plain PDF with the full letterhead (was: without it)" "$QSENT / $(doc "$WORK/quote.pdf" "HRB 4711" "Gisela Vorstand")" "201 False / plain + +"

note "=== 3. a Kleinunternehmer: the § 19 note is on every copy ==="
register klein
AS PUT "/api/v1/companies/$C?companyId=$C" '{"defaultVatMode":"kleinunternehmer","email":"rechnung@klein.example","taxId":"123/456/78901","address":{"street":"Hauptstr. 1","postalCode":"10115","city":"Berlin","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX"}}'
mailbox
KMAIL2="kunde2-$TAG@example.test"
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"Kunde Zwei\",\"type\":\"business\",\"address\":{\"street\":\"Weg 3\",\"city\":\"Hamburg\",\"postalCode\":\"20095\",\"country\":\"DE\"},\"contact\":{\"email\":\"$KMAIL2\"}}"
K2=$(P "d['id']")
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K2\",\"issueDate\":\"2026-10-01\",\"items\":[{\"description\":\"Unterricht\",\"quantity\":2,\"unit\":\"Std\",\"unitPrice\":50,\"vatRate\":0}]}"
INV2=$(P "d['id']"); NUM2=$(P "d['invoiceNumber']")
AS PUT "/api/v1/invoices/$INV2/status?companyId=$C" '{"status":"sent"}'
assert_eq "fixture: a Kleinunternehmer's issued invoice" "$STATUS" "200"
outlets "$INV2" "$NUM2" "$KMAIL2" k
assert_eq "the download names § 19 UStG (as before)" "$(doc "$WORK/k-pdf.pdf" "19 UStG")" "einvoice +"
assert_eq "GET …/zugferd too (was: no note)" "$(doc "$WORK/k-zugferd.pdf" "19 UStG")" "einvoice +"
assert_eq "the ZIP too (was: no note)" "$(doc "$WORK/k-bulk.pdf" "19 UStG")" "einvoice +"
assert_eq "the e-mailed invoice too (was: no note, no XML)" "$(doc "$WORK/k-mail.pdf" "19 UStG")" "einvoice +"
assert_eq "the one sent again too (was: no note, no XML)" "$(doc "$WORK/k-resend.pdf" "19 UStG")" "einvoice +"
assert_eq "the customer portal's too (was: no note, no XML)" "$(doc "$WORK/k-portal.pdf" "19 UStG")" "einvoice +"

note "=== 4. a second invoice under the same number: the refusal speaks to the person ==="
AS POST "/api/v1/suppliers?companyId=$C" '{"name":"Lieferant 683 GmbH"}'
SUP=$(P "d['id']")
BILL="{\"supplierId\":\"$SUP\",\"invoiceNumber\":\"RE-$TAG\",\"description\":\"Papier\",\"invoiceDate\":\"2026-10-02\",\"netAmount\":100,\"vatRate\":0,\"vatAmount\":0,\"grossAmount\":100,\"category\":\"Bürobedarf\""
AS POST "/api/v1/expenses?companyId=$C" "$BILL}"
assert_eq "fixture: an expense" "$STATUS" "201"
AS POST "/api/v1/expenses?companyId=$C" "$BILL}"
assert_eq "the same number again: 409, naming the bill already entered" "$STATUS $(P "'bereits erfasst' in d['message'] and '100,00' in d['message']")" "409 True"
assert_eq "…with a code the pages can ask on (a lock answers 409 too)" "$(P "d.get('code'), d.get('statusCode')")" "DUPLICATE_EXPENSE 409"
assert_eq "…in words for the person, not the API's field name (was: mit „confirmDuplicate“ bestätigen)" "$(P "'confirmDuplicate' in d['message'], 'bitte ausdrücklich bestätigen' in d['message']")" "False True"
AS POST "/api/v1/expenses?companyId=$C" "$BILL,\"confirmDuplicate\":true}"
assert_eq "confirmed, it is entered: 201" "$STATUS" "201"

summary
