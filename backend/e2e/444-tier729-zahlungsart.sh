#!/bin/bash
# Tier 729 — the invoice's „Zahlungsart“ is kept and printed
#
# The owner, 23.10.2026: „开发票端界面功能是否完善？“ Measured: the invoice form
# offers „Zahlungsart“ (Überweisung, Barzahlung, EC-Karte, Kreditkarte,
# PayPal); the service dropped it („paymentMethod is on Payment“). A cash sale
# printed a GiroCode to transfer the money and went out as a SEPA transfer
# (code 58) in its e-invoice.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-444-$(date +%s%N | cut -c1-13)"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
KOSIT_ROOT="$(cd "$SCRIPT_DIR/../../infra/kosit" && pwd)"
JAVA_BIN="$SCRIPT_DIR/../../infra/java/jdk-17.0.13+11/Contents/Home/bin/java"
if [[ ! -x "$JAVA_BIN" ]]; then
  if [[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/java" ]]; then JAVA_BIN="$JAVA_HOME/bin/java"
  else JAVA_BIN=$(command -v java || true); fi
fi
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier729-e2e\",\"companyName\":\"$TAG Laden\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
fetch() { curl -sS -o "$2" -w "%{http_code}" -H "x-user-id: $U" -H "x-company-id: $C" "$API$1"; }
kosit() { # file → ACCEPTABLE or the failed rules
  local out="$WORK/k-$(basename "$1")"; mkdir -p "$out"
  if (cd "$out" && "$JAVA_BIN" -jar "$KOSIT_ROOT/validator.jar" -r "$KOSIT_ROOT/repository" -s "$KOSIT_ROOT/scenarios.xml" -o "$out" "$1" >/dev/null 2>&1); then echo ACCEPTABLE
  else echo "REJECT $(grep -oh 'failed-assert[^>]*id="[^"]*"' "$out"/*.xml 2>/dev/null | head -3 | tr '\n' ' ')"; fi
}
cii_of() { python3 - "$1" <<'PY'
import re, sys, zlib
pdf = open(sys.argv[1], 'rb').read()
for m in re.finditer(rb'stream\r?\n(.*?)\r?\nendstream', pdf, re.S):
    try: data = zlib.decompress(m.group(1))
    except Exception: data = m.group(1)
    if b'CrossIndustryInvoice' in data[:2000]:
        sys.stdout.write(data.decode('utf-8')); break
PY
}
images() { python3 -c "import sys,re;print(len(re.findall(rb'/Subtype\s*/Image', open(sys.argv[1],'rb').read())))" "$1"; }
code() { python3 -c "import re,sys;m=re.search(r'<cbc:PaymentMeansCode[^>]*>(\w+)<', open(sys.argv[1],encoding='utf-8').read());print(m.group(1) if m else '-')" "$1"; }

AS PUT "/api/v1/companies/$C?companyId=$C" "{\"legalName\":\"$TAG Laden GmbH\",\"vatId\":\"DE123456789\",\"phone\":\"+49 30 1\",\"email\":\"info@laden.example.test\",\"registerEntry\":\"Amtsgericht Berlin, HRB 1\",\"address\":{\"street\":\"Hauptstr. 5\",\"postalCode\":\"10115\",\"city\":\"Berlin\",\"country\":\"DE\"},\"bankInfo\":{\"bankName\":\"Testbank\",\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\"}}"
assert_eq "fixture: a company with a bank account" "$STATUS" "200"
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde GmbH\",\"type\":\"business\",\"vatId\":\"DE987654321\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"},\"contact\":{\"email\":\"k@example.test\"}}"
K=$(json_field "$BODY" id)
TODAY=$(TZ=Europe/Berlin date +%F)   # a draft can be changed on its issue day only
inv() { # paymentMethod → I
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$TODAY\",${1:+\"paymentMethod\":\"$1\",}\"items\":[{\"description\":\"Ledertasche\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
  I=$(json_field "$BODY" id)
}

note "=== 1. a cash sale ==="
inv cash
assert_eq "kept (was: dropped)" "$STATUS/$(curl -sS -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$I?companyId=$C" | python3 -c "import sys,json;print(json.load(sys.stdin).get('paymentMethod'))")" "201/cash"
fetch "/api/v1/invoices/$I/pdf?companyId=$C" "$WORK/cash.pdf" > /dev/null
assert_eq "the PDF says so" "$(pdf_text "$WORK/cash.pdf" | grep -c 'Zahlungsart: Barzahlung.')" "1"
assert_eq "…and has no GiroCode to transfer the money (was: one)" "$(images "$WORK/cash.pdf")" "0"
fetch "/api/v1/invoices/$I/xrechnung?companyId=$C" "$WORK/cash.xml" > /dev/null
assert_eq "XRechnung: code 10, no account (was: 58 with the IBAN)" "$(code "$WORK/cash.xml")/$(grep -c 'PayeeFinancialAccount' "$WORK/cash.xml")" "10/0"
assert_eq "…KoSIT" "$(kosit "$WORK/cash.xml")" "ACCEPTABLE"
fetch "/api/v1/invoices/$I/zugferd?companyId=$C" "$WORK/cash-z.pdf" > /dev/null
cii_of "$WORK/cash-z.pdf" > "$WORK/cash-z.xml"
assert_eq "ZUGFeRD: TypeCode 10, KoSIT" "$(grep -o '<ram:TypeCode>10</ram:TypeCode>' "$WORK/cash-z.xml" | wc -l | tr -d ' ')/$(kosit "$WORK/cash-z.xml")" "1/ACCEPTABLE"

note "=== 2. card and PayPal ==="
# a card: ZZZ and its name — 54 / 55 need the card number (BG-18, BR-DE-24)
for pair in "ec_card:ZZZ:EC-Karte (girocard)" "credit_card:ZZZ:Kreditkarte" "paypal:68:PayPal"; do
  m=${pair%%:*}; rest=${pair#*:}; c=${rest%%:*}; label=${rest#*:}
  inv "$m"
  fetch "/api/v1/invoices/$I/xrechnung?companyId=$C" "$WORK/$m.xml" > /dev/null
  fetch "/api/v1/invoices/$I/pdf?companyId=$C" "$WORK/$m.pdf" > /dev/null
  assert_eq "$m: code $c, „Zahlungsart: $label“, KoSIT" \
    "$(code "$WORK/$m.xml")/$(pdf_text "$WORK/$m.pdf" | grep -c "Zahlungsart: $label.")/$(kosit "$WORK/$m.xml")" "$c/1/ACCEPTABLE"
done

note "=== 3. a transfer, as before ==="
inv ""
fetch "/api/v1/invoices/$I/pdf?companyId=$C" "$WORK/t.pdf" > /dev/null
fetch "/api/v1/invoices/$I/xrechnung?companyId=$C" "$WORK/t.xml" > /dev/null
assert_eq "no „Zahlungsart“ line, the GiroCode (2 image objects), code 58" \
  "$(pdf_text "$WORK/t.pdf" | grep -c 'Zahlungsart')/$(images "$WORK/t.pdf")/$(code "$WORK/t.xml")" "0/2/58"
AS PUT "/api/v1/invoices/$I?companyId=$C" '{"paymentMethod":"paypal"}'
assert_eq "changed on the draft" "$STATUS/$(json_field "$BODY" paymentMethod)" "200/paypal"
AS PUT "/api/v1/invoices/$I?companyId=$C" '{"paymentMethod":"bank_transfer"}'
assert_eq "…back to a transfer (stored as the default)" "$STATUS/$(json_field "$BODY" paymentMethod)" "200/"
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-10-01\",\"paymentMethod\":\"bitcoin\",\"items\":[{\"description\":\"x\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1,\"vatRate\":0.19}]}"
assert_eq "an unknown means: 400" "$STATUS" "400"

summary
