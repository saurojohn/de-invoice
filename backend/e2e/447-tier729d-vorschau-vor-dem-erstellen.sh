#!/bin/bash
# Tier 729d — the invoice form previews what it holds, before „Rechnung erstellen“
#
# Measured: the form had „Rechnung erstellen“ and „Speichern und drucken“ —
# to see the PDF, an invoice had to be created, which takes a number of the
# gap-free sequence (§ 14 Abs. 4 Nr. 4 UStG). POST /invoices/preview runs
# every check and computation of a create, takes no number and stores nothing.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-447-$(date +%s%N | cut -c1-13)"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier729d-e2e\",\"companyName\":\"$TAG Werkstatt\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
preview() { # body → $WORK/p.pdf, the status
  curl -sS -o "$WORK/p.pdf" -w "%{http_code}" -X POST "$API/api/v1/invoices/preview?companyId=$C" \
    -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" -d "$1"
}
count() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "select count(*) from \"Invoice\" where \"companyId\"='$C'"; }
AS PUT "/api/v1/companies/$C?companyId=$C" "{\"legalName\":\"$TAG Werkstatt GmbH\",\"vatId\":\"DE123456789\",\"address\":{\"street\":\"Hauptstr. 5\",\"postalCode\":\"10115\",\"city\":\"Berlin\",\"country\":\"DE\"},\"bankInfo\":{\"bankName\":\"Testbank\",\"iban\":\"DE89370400440532013000\",\"bic\":\"COBADEFFXXX\"}}"
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde AG\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
BODYJSON="{\"customerId\":\"$K\",\"issueDate\":\"2026-10-01\",\"paymentMethod\":\"cash\",\"orderReference\":\"PO-447\",\"discountPercent\":10,\"items\":[{\"description\":\"Ledertasche\",\"quantity\":2,\"unit\":\"Stk\",\"unitPrice\":50,\"vatRate\":0.19}]}"
AS POST "/api/v1/invoices?companyId=$C" "$BODYJSON"
FIRST=$(json_field "$BODY" invoiceNumber)
[[ "$STATUS" == 201 ]] && pass "fixture: a first invoice ($FIRST)" || fail "first invoice: $STATUS"
BEFORE=$(count)

note "=== 1. the preview ==="
assert_eq "a PDF (there was no such route)" "$(preview "$BODYJSON")/$(head -c 4 "$WORK/p.pdf")" "200/%PDF"
T=$(pdf_text "$WORK/p.pdf" --lines | sed 's/\xc2\xa0/ /g')
assert_eq "„VORSCHAU“ for the number, the draft's watermark" "$(echo "$T" | grep -c '^VORSCHAU$')/$(echo "$T" | grep -c 'ENTWURF')" "1/2"
assert_eq "the customer, the order number, the payment method" \
  "$(echo "$T" | grep -c "$TAG Kunde AG")/$(echo "$T" | grep -c 'PO-447')/$(echo "$T" | grep -c 'Zahlungsart: Barzahlung')" "1/1/1"
assert_eq "computed as a create does: 100 − 10 % + 19 % = 107,10 €" "$(echo "$T" | grep -c '107,10 €')" "1"

note "=== 2. nothing stored, no number taken ==="
assert_eq "no invoice more" "$(count)" "$BEFORE"
AS POST "/api/v1/invoices?companyId=$C" "$BODYJSON"
NEXT=$(json_field "$BODY" invoiceNumber)
assert_eq "the next invoice: the next number (the preview took none)" \
  "$(python3 -c "import sys,re;a,b=sys.argv[1:3];print(int(re.findall(r'\d+$',b)[0])-int(re.findall(r'\d+$',a)[0]))" "$FIRST" "$NEXT")" "1"

note "=== 3. the checks of a create ==="
# (the bodies built here: inside "$( … )" bash brace-expands a JSON written with \")
ITEM='{"description":"x","quantity":1,"unit":"Stk","unitPrice":1,"vatRate":0.19}'
UNKNOWN="{\"customerId\":\"00000000-0000-0000-0000-000000000000\",\"issueDate\":\"2026-10-01\",\"items\":[$ITEM]}"
CN="{\"type\":\"CN\",\"customerId\":\"$K\",\"issueDate\":\"2026-10-01\",\"items\":[$ITEM]}"
BITCOIN="{\"customerId\":\"$K\",\"issueDate\":\"2026-10-01\",\"paymentMethod\":\"bitcoin\",\"items\":[$ITEM]}"
python3 -c "import json,sys;[json.loads(a) for a in sys.argv[1:]]" "$UNKNOWN" "$CN" "$BITCOIN" && pass "fixture: three valid JSON bodies" || fail "the bodies are no JSON"
why() { python3 -c "import json,sys;d=json.load(open(sys.argv[1]));m=d.get('message');print(m if isinstance(m,str) else '; '.join(m))" "$WORK/p.pdf" 2>/dev/null; }
S1=$(preview "$UNKNOWN"); W1=$(why)
assert_eq "an unknown customer: as a create (400 / 404)" "$(echo "$S1" | grep -cE '^(400|404)$')" "1"
note "  ($S1: $W1)"
S2=$(preview "$CN"); W2=$(why)
assert_eq "a credit note without the invoice it corrects: 400, and why" "$S2/$(echo "$W2" | grep -ci 'rechnung')" "400/1"
S3=$(preview "$BITCOIN"); W3=$(why)
assert_eq "an unknown payment means: 400, and why" "$S3/$(echo "$W3" | grep -c 'paymentMethod')" "400/1"
assert_eq "…and still nothing stored" "$(count)" "$((BEFORE + 1))"

summary
