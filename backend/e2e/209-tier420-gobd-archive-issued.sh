#!/bin/bash
# Tier 420 — the GoBD archive holds the invoices as issued, and counts only them
#
# Measured on one company — a sent 1 000 € invoice, a 500 € draft, a cancelled
# 300 € invoice:
#   summary  totalRevenueNet 1 500 / totalVat 285   (the draft counted)
#   manifest revenueNet 1 800 / vat 342             (draft and cancelled counted)
#   archived PDFs re-rendered from { name, taxId } — no seller address, no
#   USt-IdNr., no bank details: not the invoice the customer received
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-209-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier420-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS PUT "/api/v1/companies/$C?companyId=$C" '{"vatId":"DE123456789","address":{"street":"Altstraße 1","city":"Berlin","postalCode":"10115","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX","bankName":"Bank"}}'
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde\",\"type\":\"business\"}"; K=$(json_field "$BODY" id)
mk() { AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-08-10\",\"items\":[{\"description\":\"$1\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$2,\"vatRate\":0.19}]}"; json_field "$BODY" id; }
status() { AS PUT "/api/v1/invoices/$1/status?companyId=$C" "{\"status\":\"$2\"}"; }
SENT=$(mk Gesendet 1000); status "$SENT" sent
NEVER=$(mk NieHeruntergeladen 200); status "$NEVER" sent
DRAFT=$(mk Entwurf 500)
CANC=$(mk Storniert 300); status "$CANC" sent; status "$CANC" cancelled
pass "fixture: sent 1000 + sent 200, a 500 draft, a cancelled 300"

WORK=$(mktemp -d)
# Issue the first one: its first PDF download is stored as the issued document.
curl -sS -o "$WORK/issued.pdf" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/invoices/$SENT/pdf?companyId=$C&sign=false"
# … then the company moves.
AS PUT "/api/v1/companies/$C?companyId=$C" '{"address":{"street":"Neustraße 9","city":"Hamburg","postalCode":"20095","country":"DE"}}'

note "=== 1. summary counts issued invoices only ==="
AS GET "/api/v1/accounting/gobd-archive/summary?companyId=$C&year=2026"
assert_eq "totalRevenueNet 1200 (was 1700 — the draft counted)" "$(json_field "$BODY" totalRevenueNet)" "1200"
assert_eq "totalVat 228" "$(json_field "$BODY" totalVat)" "228"
assert_eq "invoiceCount 3 — the draft is not an issued document" "$(json_field "$BODY" invoiceCount)" "3"

note "=== 2. the archive ==="
curl -sS -o "$WORK/a.zip" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/accounting/gobd-archive?companyId=$C&year=2026"
(cd "$WORK" && unzip -o -q a.zip)
assert_eq "3 invoice PDFs (sent, sent, cancelled — no draft)" "$(ls "$WORK/Invoices" | wc -l | tr -d ' ')" "3"
assert_eq "manifest revenueNet 1200 (was 2000 — draft and cancelled counted)" \
  "$(python3 -c "import json;print(json.load(open('$WORK/MANIFEST.json'))['totals']['revenueNet'])")" "1200"
PDFTXT() { python3 - "$1" <<'PY'
import re, sys, zlib
d = open(sys.argv[1], 'rb').read(); out = []
for m in re.finditer(rb'/Filter /FlateDecode[^>]*>>\s*stream\r?\n(.*?)\r?\nendstream', d, re.DOTALL):
    try: dec = zlib.decompress(m.group(1))
    except Exception: continue
    out.append(b''.join(bytes.fromhex(h.decode()) for h in re.findall(rb'<([0-9A-Fa-f]+)>', dec)).decode('latin-1', 'ignore'))
print(' '.join(out))
PY
}
ISSUED_NO=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "select \"invoiceNumber\" from \"Invoice\" where id='$SENT'")
NEVER_NO=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "select \"invoiceNumber\" from \"Invoice\" where id='$NEVER'")
A_ISSUED="$WORK/Invoices/$ISSUED_NO.pdf"
A_NEVER="$WORK/Invoices/$NEVER_NO.pdf"
assert_eq "the downloaded invoice is archived byte for byte as issued" \
  "$(shasum -a 256 < "$A_ISSUED" | cut -d' ' -f1)" "$(shasum -a 256 < "$WORK/issued.pdf" | cut -d' ' -f1)"
PDFTXT "$A_ISSUED" | grep -q "Altstraße" && pass "…with the address it was issued with (Altstraße)" || fail "issued address missing"
T=$(PDFTXT "$A_NEVER")
grep -q "DE123456789" <<<"$T" && pass "a never-downloaded invoice is rendered with the USt-IdNr. (was missing)" || fail "USt-IdNr. missing"
grep -q "DE89370400440532013000" <<<"$T" && pass "…and the IBAN (was missing)" || fail "IBAN missing"
grep -q "Neustraße" <<<"$T" && pass "…and the company's current address" || fail "address missing"

rm -rf "$WORK"
summary; exit $?
