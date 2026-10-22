#!/bin/bash
# Tier 728b — the reminder and the statement carry what a business letter must
#
# § 35a GmbHG, § 37a HGB: every business letter — not only the invoice —
# states the full name with the legal form, the seat, the register court and
# number, and all managing directors. Measured with every company field
# filled in:
#   - the Mahnung's footer: name, address, e-mail, tax numbers in one line
#     that ran off the page; no register, no directors, no seat, no phone;
#     „USt-ID“; the countries as codes („DE“, „AT“);
#   - the statement: the same gaps, „Customer Statement — “ in its German
#     heading, „USt-ID“, the footer broke between „IBAN“ and the number, and
#     the PDF listed the entries newest first under „Anfangsbestand“.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-440-$(date +%s%N | cut -c1-13)"
WORK=$(mktemp -d); BOX="$WORK/box"
python3 "$SCRIPT_DIR/fixtures/smtp-sink.py" "$BOX" > "$WORK/port" 2> "$WORK/sink.err" < /dev/null &
SINK=$!
trap '{ kill $SINK; wait $SINK; } 2>/dev/null; rm -rf "$WORK"' EXIT
for _ in $(seq 1 50); do [[ -s "$WORK/port" ]] && break; python3 -c "import time; time.sleep(0.1)"; done
PORT=$(cat "$WORK/port")
[[ -n "$PORT" ]] && pass "fixture: a mailbox on 127.0.0.1:$PORT" || { fail "the mailbox did not start"; summary; exit 1; }
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier728b-e2e\",\"companyName\":\"$TAG Werkstatt\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS PUT "/api/v1/companies/$C?companyId=$C" "{\"name\":\"$TAG Werkstatt\",\"legalName\":\"$TAG Werkstatt Lederwaren GmbH\",\"rechtsform\":\"GmbH\",\"vatId\":\"DE123456789\",\"taxId\":\"12/345/67890\",\"phone\":\"+49 30 1234567\",\"email\":\"info@werkstatt.example.test\",\"website\":\"www.werkstatt.example.test\",\"registerEntry\":\"Amtsgericht Berlin-Charlottenburg, HRB 123456 B\",\"managingDirector\":\"Anna Beispiel, Bernd Muster\",\"otherInfo\":\"WEEE-Reg.-Nr. DE 12345678\",\"address\":{\"street\":\"Hauptstr. 5\",\"postalCode\":\"10115\",\"city\":\"Berlin\",\"country\":\"DE\"},\"bankInfo\":{\"bankName\":\"Testbank\",\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\"}}"
assert_eq "fixture: the company's details" "$STATUS" "200"
AS PUT "/api/v1/mail/config?companyId=$C" "{\"smtpHost\":\"127.0.0.1\",\"smtpPort\":$PORT,\"smtpSecure\":false,\"smtpUser\":\"u\",\"smtpPassword\":\"p\",\"fromEmail\":\"rechnung@example.test\",\"fromName\":\"$TAG\",\"enabled\":true}"
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde GmbH\",\"type\":\"business\",\"vatId\":\"ATU12345678\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"1010\",\"city\":\"Wien\",\"country\":\"AT\"},\"contact\":{\"email\":\"buchhaltung@kunde.example.test\"}}"
K=$(json_field "$BODY" id)
inv() { # issueDate dueDate → I
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$1\",\"dueDate\":\"$2\",\"items\":[{\"description\":\"Leistung\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
  I=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
}
inv 2026-07-01 2026-07-15; FIRST=$I
inv 2026-08-01 2026-08-15; SECOND=$I
lines() { pdf_text "$1" --lines | sed 's/\xc2\xa0/ /g'; }
keep() { [[ -n "${KEEP_PDF:-}" ]] && cp "$1" "$KEEP_PDF/" ; true; }

note "=== 1. the Mahnung ==="
AS POST "/api/v1/reminders/send" "{\"companyId\":\"$C\",\"invoiceId\":\"$FIRST\",\"level\":\"first\",\"createdById\":\"$U\"}"
M=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "select id from \"Mahnung\" where \"invoiceId\"='$FIRST' order by \"createdAt\" desc limit 1")
curl -sS -o "$WORK/mahnung.pdf" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/reminders/mahnungen/$M/pdf?companyId=$C"; keep "$WORK/mahnung.pdf"
L=$(lines "$WORK/mahnung.pdf")
has() { echo "$L" | grep -qF "$1" && echo yes || echo no; }
assert_eq "the register details (was: none)" \
  "$(has "Sitz der Gesellschaft: Berlin")/$(has "Handelsregister: Amtsgericht Berlin-Charlottenburg, HRB 123456 B")/$(has "Geschäftsführer: Anna Beispiel, Bernd Muster")" "yes/yes/yes"
assert_eq "…phone, website, the other details, the bank (was: no phone, no website)" \
  "$(has "Tel. +49 30 1234567")/$(has "www.werkstatt.example.test")/$(has "WEEE-Reg.-Nr. DE 12345678")/$(has "IBAN DE89370400440532013000")" "yes/yes/yes/yes"
assert_eq "„USt-IdNr.“ (was „USt-ID“)" "$(has "USt-IdNr. DE123456789")/$(has "USt-ID ")" "yes/no"
assert_eq "the countries in full (was: „DE“, „AT“)" "$(has "ÖSTERREICH")/$(has "· DEUTSCHLAND")" "yes/yes"
assert_eq "one page" "$(pdf_text "$WORK/mahnung.pdf" | grep -c 'Seite 2' )" "0"

note "=== 1b. the e-mail with it (Tier 728c) ==="
MAILTEXT=$(python3 - "$BOX" <<'PY'
import email, os, sys
d = sys.argv[1]
f = sorted(os.listdir(d))[-1]
m = email.message_from_bytes(open(os.path.join(d, f), 'rb').read())
for part in m.walk():
    if part.get_content_type() == 'text/plain':
        text = part.get_payload(decode=True).decode('utf-8', 'replace').replace('\u00a0', ' ').replace('\r\n', '\n')
        # what stands below the signature separator „-- “
        print(text.split('\n-- \n', 1)[1] if '\n-- \n' in text else '')
        break
PY
)
sig="$MAILTEXT"
assert_eq "below „-- “: the full name, the register details, the tax numbers (was: the name only)" \
  "$(echo "$sig" | grep -c "$TAG Werkstatt Lederwaren GmbH")/$(echo "$sig" | grep -c "Handelsregister: Amtsgericht Berlin-Charlottenburg, HRB 123456 B")/$(echo "$sig" | grep -c "Geschäftsführer: Anna Beispiel, Bernd Muster")/$(echo "$sig" | grep -c "USt-IdNr. DE123456789")" "1/1/1/1"

note "=== 2. the statement ==="
curl -sS -o "$WORK/st.pdf" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/customers/$K/statement.pdf?companyId=$C&from=2026-06-01&to=2026-10-31"; keep "$WORK/st.pdf"
L=$(lines "$WORK/st.pdf")
assert_eq "the register details, the full name" \
  "$(has "Sitz der Gesellschaft: Berlin")/$(has "Geschäftsführer: Anna Beispiel, Bernd Muster")/$(has "$TAG Werkstatt Lederwaren GmbH")" "yes/yes/yes"
assert_eq "a German heading (was „Customer Statement — …“), „USt-IdNr.“" "$(has "Customer Statement")/$(has "USt-IdNr. DE123456789")/$(has "USt-ID ")" "no/yes/no"
assert_eq "„IBAN“ and the number on one line" "$(echo "$L" | grep -c 'IBAN DE89370400440532013000')" "1"
assert_eq "chronological — July before August (was: newest first)" \
  "$(echo "$L" | grep -nE '^INV-' | head -2 | cut -d: -f2 | tr '\n' ' ')" "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "select string_agg(\"invoiceNumber\", ' ' order by \"issueDate\") || ' ' from \"Invoice\" where id in ('$FIRST','$SECOND')")"

summary
