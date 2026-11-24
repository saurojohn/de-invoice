#!/bin/bash
# Tier 980 — the XRechnung (UBL) and the PDF state the agreed unit price
#
# UBL wrote quantity and unit price with two decimals: 1 000 kWh × 0,1234 € =
# 123,40 € went out as 1000.00 × 0.12 (= 120,00), 0,125 h × 80 € = 10,00 € as
# 0.13 × 80 (= 10,40) — KoSIT: REJECT, PEPPOL-EN16931-R120 on both lines; the
# CII (ZUGFeRD) carried four. The PDF printed "0,12 €" per kWh.
# § 14 Abs. 4 Nr. 5 / Abs. 1 Satz 3 UStG (EN 16931).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-667-$(date +%s%N | cut -c1-13)"
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
D=$(TZ=Europe/Berlin date -v-2d +%F 2>/dev/null || TZ=Europe/Berlin date -d '2 days ago' +%F)

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier980-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
fixture_issuer "$C"
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" '{"name":"Stadtwerk Kunde GmbH","type":"business","vatId":"DE123456789","address":{"street":"a","city":"Köln","postalCode":"50667","country":"DE"}}'
K=$(json_field "$BODY" id)
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$D\",\"deliveryDate\":\"$D\",\"items\":[{\"description\":\"Strom\",\"quantity\":1000,\"unit\":\"kWh\",\"unitPrice\":0.1234,\"vatRate\":0.19},{\"description\":\"Beratung\",\"quantity\":0.125,\"unit\":\"Std\",\"unitPrice\":80,\"vatRate\":0.19}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I/status?companyId=$C" '{"status":"sent"}'
assert_eq "fixture: issued" "$STATUS" "200"
AS GET "/api/v1/invoices/$I/xrechnung?companyId=$C"
echo "$BODY" > "$W/x.xml"
assert_eq "UBL: quantity × price = line net on every line (was 1000.00×0.12=123.40, 0.13×80=10.00)" \
  "$(python3 - "$W/x.xml" <<'PY'
import sys,re
x=open(sys.argv[1]).read()
out=[]
for l in re.findall(r'<cac:InvoiceLine>.*?</cac:InvoiceLine>', x, re.S):
    q=re.search(r'<cbc:InvoicedQuantity[^>]*>([^<]+)<',l).group(1)
    p=re.search(r'<cbc:PriceAmount[^>]*>([^<]+)<',l).group(1)
    n=re.search(r'<cbc:LineExtensionAmount[^>]*>([^<]+)<',l).group(1)
    ok = abs(round(float(q) * float(p) * 100) - round(float(n) * 100)) < 1
    out.append(q + 'x' + p + '=' + n + ':' + str(ok))
print(' '.join(out))
PY
)" "1000.00x0.1234=123.40:True 0.125x80.00=10.00:True"
curl -sS -o "$W/i.pdf" "$API/api/v1/invoices/$I/pdf?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C"
assert_eq "the PDF: the unit price as agreed, 0,1234 € (was 0,12 €)" "$(pdf_text "$W/i.pdf" | grep -c '0,1234')" "1"

summary
